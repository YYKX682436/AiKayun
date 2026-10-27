import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

/** Identity only. No procurement protocol, budget, worker or sale switch is installed here. */
export const procurementIdentityMigration: Migration = {
  async up(db) {
    await sql`
      CREATE TABLE order_item_procurement_sources (
        id uuid PRIMARY KEY,
        order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
        order_item_id uuid NOT NULL UNIQUE REFERENCES order_item_purchase_snapshots(order_item_id) ON DELETE RESTRICT,
        product_id uuid NOT NULL,
        product_variant_id uuid NOT NULL,
        mapping_version_id uuid NOT NULL REFERENCES supplier_product_mapping_versions(id) ON DELETE RESTRICT,
        supplier_connection_id uuid NOT NULL,
        supplier_connection_version_id uuid NOT NULL,
        credential_version integer NOT NULL,
        provider_type varchar(32) NOT NULL DEFAULT 'kayixin_customer_v3',
        template_version_id uuid NOT NULL REFERENCES purchase_form_template_versions(id) ON DELETE RESTRICT,
        template_sha256 char(64) NOT NULL,
        normalization_version smallint NOT NULL,
        content_identity char(64) NOT NULL,
        rules_sha256 char(64) NOT NULL,
        structure_sha256 char(64) NOT NULL,
        upstream_product_id varchar(32) NOT NULL,
        upstream_sku_type smallint NOT NULL,
        upstream_sku_code varchar(200),
        upstream_combination jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT procurement_source_item_identity_fkey FOREIGN KEY (order_item_id, product_id, product_variant_id)
          REFERENCES order_items(id, product_id, product_variant_id) ON DELETE RESTRICT,
        CONSTRAINT procurement_source_connection_version_fkey FOREIGN KEY (supplier_connection_version_id, supplier_connection_id, provider_type)
          REFERENCES supplier_connection_versions(id, supplier_connection_id, provider_type) ON DELETE RESTRICT,
        CONSTRAINT procurement_source_credential_fkey FOREIGN KEY (supplier_connection_id, credential_version)
          REFERENCES supplier_connection_credentials(supplier_connection_id, credential_version) ON DELETE RESTRICT,
        CONSTRAINT procurement_source_id_item_unique UNIQUE (id, order_item_id),
        CONSTRAINT procurement_source_provider_check CHECK (provider_type = 'kayixin_customer_v3'),
        CONSTRAINT procurement_source_hash_check CHECK (template_sha256 ~ '^[0-9a-f]{64}$'
          AND content_identity ~ '^[0-9a-f]{64}$' AND rules_sha256 ~ '^[0-9a-f]{64}$'
          AND structure_sha256 ~ '^[0-9a-f]{64}$'),
        CONSTRAINT procurement_source_combination_check CHECK (jsonb_typeof(upstream_combination) = 'array')
      )
    `.execute(db)

    // The only supported insertion point is the original, still-unsealed
    // order transaction. No current production selector returns a source.
    await sql`
      CREATE FUNCTION guard_order_item_procurement_source() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE parent orders%ROWTYPE; item order_items%ROWTYPE;
        purchase order_item_purchase_snapshots%ROWTYPE; mapping supplier_product_mapping_versions%ROWTYPE;
        head supplier_product_mapping_heads%ROWTYPE; connection supplier_connections%ROWTYPE;
        version supplier_connection_versions%ROWTYPE;
      BEGIN
        SELECT order_row.* INTO parent FROM orders AS order_row
          JOIN order_items AS line ON line.order_id = order_row.id
          WHERE line.id = NEW.order_item_id FOR UPDATE OF order_row;
        SELECT * INTO item FROM order_items WHERE id = NEW.order_item_id FOR UPDATE;
        SELECT * INTO purchase FROM order_item_purchase_snapshots WHERE order_item_id = NEW.order_item_id;
        SELECT * INTO mapping FROM supplier_product_mapping_versions WHERE id = NEW.mapping_version_id;
        IF parent.id IS NULL OR parent.items_sealed OR parent.purchase_snapshot_version <> 2
          OR item.id IS NULL OR purchase.order_item_id IS NULL OR mapping.id IS NULL
          OR parent.id <> NEW.order_id OR item.product_id <> NEW.product_id
          OR item.product_variant_id <> NEW.product_variant_id THEN
          RAISE EXCEPTION 'Procurement source must be bound inside its original order transaction'
            USING ERRCODE = '23514', CONSTRAINT = 'procurement_source_order_identity_invalid';
        END IF;
        SELECT * INTO connection FROM supplier_connections WHERE id = mapping.supplier_connection_id FOR SHARE;
        SELECT * INTO version FROM supplier_connection_versions WHERE id = mapping.supplier_connection_version_id;
        PERFORM id FROM purchase_form_template_versions WHERE id = mapping.template_version_id FOR SHARE;
        SELECT * INTO head FROM supplier_product_mapping_heads WHERE id = mapping.mapping_id FOR SHARE;
        IF head.id IS NULL OR head.status <> 'reviewed' OR head.latest_review_version_id IS DISTINCT FROM mapping.id
          OR connection.current_version_id IS DISTINCT FROM mapping.supplier_connection_version_id
          OR version.id IS NULL OR version.provider_type <> 'kayixin_customer_v3'
          OR ROW(mapping.product_id, mapping.product_variant_id, mapping.supplier_connection_id,
              mapping.supplier_connection_version_id, version.credential_version, mapping.template_version_id,
              mapping.template_sha256, mapping.normalization_version, mapping.rules_sha256,
              mapping.upstream_structure_sha256, mapping.upstream_product_id, mapping.upstream_sku_type,
              mapping.upstream_sku_code, mapping.upstream_combination)
            IS DISTINCT FROM ROW(NEW.product_id, NEW.product_variant_id, NEW.supplier_connection_id,
              NEW.supplier_connection_version_id, NEW.credential_version, NEW.template_version_id,
              NEW.template_sha256, NEW.normalization_version, NEW.rules_sha256,
              NEW.structure_sha256, NEW.upstream_product_id, NEW.upstream_sku_type,
              NEW.upstream_sku_code, NEW.upstream_combination)
          OR ROW(purchase.template_version_id, purchase.normalization_version, purchase.content_identity)
            IS DISTINCT FROM ROW(NEW.template_version_id, NEW.normalization_version, NEW.content_identity) THEN
          RAISE EXCEPTION 'Procurement source does not match its reviewed current mapping and order snapshot'
            USING ERRCODE = '23514', CONSTRAINT = 'procurement_source_version_mismatch';
        END IF;
        RETURN NEW;
      END $$
    `.execute(db)
    await sql`CREATE TRIGGER procurement_source_insert_guard BEFORE INSERT ON order_item_procurement_sources
      FOR EACH ROW EXECUTE FUNCTION guard_order_item_procurement_source()`.execute(db)
    await sql`CREATE TRIGGER procurement_source_immutable BEFORE UPDATE OR DELETE ON order_item_procurement_sources
      FOR EACH ROW EXECUTE FUNCTION protect_order_purchase_immutable()`.execute(db)
    await sql`CREATE TRIGGER procurement_source_no_truncate BEFORE TRUNCATE ON order_item_procurement_sources
      FOR EACH STATEMENT EXECUTE FUNCTION protect_order_purchase_immutable()`.execute(db)

    // Strictly stronger than free-order delivery eligibility. There is no
    // reference to catalog prices, supplier quotes or procurement budgets.
    await sql`
      CREATE FUNCTION procurement_order_financially_eligible(order_uuid uuid) RETURNS boolean
      LANGUAGE sql VOLATILE AS $$
        SELECT COALESCE((SELECT parent.items_sealed AND parent.status = 'processing' AND parent.total_amount > 0
          AND NOT order_has_unresolved_payment_attempts(parent.id)
          AND NOT EXISTS (SELECT 1 FROM payment_attempts p WHERE p.order_id = parent.id
            AND p.status IN ('created', 'pending', 'reconciliation_required'))
          AND NOT EXISTS (SELECT 1 FROM payment_attempts p JOIN payment_provider_reconciliation_cases c
            ON c.payment_attempt_id = p.id WHERE p.order_id = parent.id AND c.state = 'open')
          AND NOT EXISTS (SELECT 1 FROM order_refunds r WHERE r.order_id = parent.id
            AND r.status IN ('requested', 'approved', 'processing', 'partially_succeeded'))
          AND NOT EXISTS (SELECT 1 FROM payment_attempts p JOIN payment_receipts r ON r.payment_attempt_id = p.id
            WHERE p.order_id = parent.id AND (r.refunded_amount > 0 OR r.refund_reserved_amount > 0))
          AND COALESCE((SELECT sum(r.amount) FROM payment_attempts p JOIN payment_receipts r ON r.payment_attempt_id = p.id
            WHERE p.order_id = parent.id AND p.status = 'succeeded' AND r.disposition = 'on_time'), 0) = parent.total_amount
          FROM orders parent WHERE parent.id = order_uuid), false)
      $$
    `.execute(db)

    await sql`
      CREATE TABLE procurement_operations (
        id uuid PRIMARY KEY,
        local_business_number varchar(64) NOT NULL UNIQUE,
        source_id uuid NOT NULL,
        order_item_id uuid NOT NULL,
        state varchar(32) NOT NULL DEFAULT 'prepared',
        allocations_sealed boolean NOT NULL DEFAULT false,
        revision integer NOT NULL DEFAULT 0,
        supplier_order_number varchar(200),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT procurement_operation_source_fkey FOREIGN KEY (source_id, order_item_id)
          REFERENCES order_item_procurement_sources(id, order_item_id) ON DELETE RESTRICT,
        CONSTRAINT procurement_operation_id_item_unique UNIQUE (id, order_item_id),
        CONSTRAINT procurement_operation_business_number_check CHECK (local_business_number = 'local-procurement:' || id::text),
        CONSTRAINT procurement_operation_state_check CHECK (state IN ('prepared', 'submit_in_flight', 'accepted_pending',
          'unknown', 'manual_review', 'rejected', 'success_pending_finalize', 'completed')),
        CONSTRAINT procurement_operation_revision_check CHECK (revision >= 0),
        CONSTRAINT procurement_operation_accepted_number_required CHECK (state <> 'accepted_pending' OR supplier_order_number IS NOT NULL),
        CONSTRAINT procurement_operation_supplier_number_check CHECK (supplier_order_number IS NULL
          OR (length(btrim(supplier_order_number)) BETWEEN 1 AND 200))
      )
    `.execute(db)
    await sql`
      CREATE TABLE procurement_operation_units (
        operation_id uuid NOT NULL,
        order_item_id uuid NOT NULL,
        unit_index integer NOT NULL,
        state varchar(32) NOT NULL DEFAULT 'allocated',
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT procurement_unit_pkey PRIMARY KEY (operation_id, unit_index),
        CONSTRAINT procurement_unit_operation_fkey FOREIGN KEY (operation_id, order_item_id)
          REFERENCES procurement_operations(id, order_item_id) ON DELETE RESTRICT,
        CONSTRAINT procurement_unit_index_check CHECK (unit_index > 0),
        CONSTRAINT procurement_unit_state_check CHECK (state IN ('allocated', 'unknown', 'manual_review',
          'success_pending_finalize', 'completed', 'rejected'))
      )
    `.execute(db)
    await sql`CREATE UNIQUE INDEX procurement_unit_one_obligation ON procurement_operation_units(order_item_id, unit_index)
      WHERE state <> 'rejected'`.execute(db)
    // Reuse the existing refund protection. Even a prepared identity is a
    // conservative obligation until an explicit rejected terminal result.
    await sql`
      CREATE OR REPLACE FUNCTION order_has_unresolved_fulfillment(order_uuid uuid) RETURNS boolean
      LANGUAGE sql STABLE AS $$
        SELECT EXISTS (SELECT 1 FROM order_items AS item WHERE item.order_id = order_uuid
          AND (item.fulfillment_reserved_quantity > 0 OR EXISTS (
            SELECT 1 FROM order_item_fulfillment_attempts AS attempt WHERE attempt.order_item_id = item.id
              AND attempt.status IN ('processing', 'unknown'))))
          OR EXISTS (SELECT 1 FROM procurement_operations AS operation
            JOIN order_items AS item ON item.id = operation.order_item_id
            WHERE item.order_id = order_uuid AND operation.state NOT IN ('rejected', 'completed'))
      $$
    `.execute(db)
    await sql`
      CREATE TABLE procurement_operation_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        operation_id uuid NOT NULL REFERENCES procurement_operations(id) ON DELETE RESTRICT,
        previous_state varchar(32),
        next_state varchar(32) NOT NULL,
        revision integer NOT NULL,
        supplier_order_number varchar(200),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT procurement_event_revision_unique UNIQUE (operation_id, revision)
      )
    `.execute(db)
    await sql`
      CREATE TABLE procurement_unit_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        operation_id uuid NOT NULL,
        unit_index integer NOT NULL,
        previous_state varchar(32),
        next_state varchar(32) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT procurement_unit_event_unit_fkey FOREIGN KEY (operation_id, unit_index)
          REFERENCES procurement_operation_units(operation_id, unit_index) ON DELETE RESTRICT
      )
    `.execute(db)

    await sql`
      CREATE FUNCTION guard_procurement_operation() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE parent_id uuid;
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'Procurement identities are permanent' USING ERRCODE = '23514', CONSTRAINT = 'procurement_operation_immutable';
        END IF;
        IF TG_OP = 'INSERT' THEN
          IF NEW.state <> 'prepared' OR NEW.allocations_sealed OR NEW.revision <> 0 OR NEW.supplier_order_number IS NOT NULL THEN
            RAISE EXCEPTION 'Procurement operation must begin prepared' USING ERRCODE = '23514', CONSTRAINT = 'procurement_operation_initial_state';
          END IF;
          SELECT order_id INTO parent_id FROM order_item_procurement_sources
            WHERE id = NEW.source_id AND order_item_id = NEW.order_item_id;
          PERFORM id FROM orders WHERE id = parent_id FOR UPDATE;
          PERFORM id FROM order_items WHERE id = NEW.order_item_id AND order_id = parent_id FOR UPDATE;
          IF parent_id IS NULL OR NOT procurement_order_financially_eligible(parent_id) THEN
            RAISE EXCEPTION 'Procurement requires confirmed payment and no conflicting payment or refund'
              USING ERRCODE = '23514', CONSTRAINT = 'procurement_payment_ineligible';
          END IF;
          RETURN NEW;
        END IF;
        IF ROW(NEW.id, NEW.local_business_number, NEW.source_id, NEW.order_item_id, NEW.created_at)
          IS DISTINCT FROM ROW(OLD.id, OLD.local_business_number, OLD.source_id, OLD.order_item_id, OLD.created_at)
          OR (OLD.supplier_order_number IS NOT NULL AND NEW.supplier_order_number IS DISTINCT FROM OLD.supplier_order_number)
          OR NEW.revision <> OLD.revision + 1 OR (OLD.allocations_sealed AND NOT NEW.allocations_sealed) THEN
          RAISE EXCEPTION 'Procurement operation identity, known supplier number and allocations are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'procurement_operation_identity_immutable';
        END IF;
        IF OLD.state IN ('completed', 'rejected') THEN
          RAISE EXCEPTION 'A confirmed terminal operation cannot be overwritten'
            USING ERRCODE = '23514', CONSTRAINT = 'procurement_operation_terminal_immutable';
        END IF;
        IF NEW.supplier_order_number IS NOT NULL AND NEW.state IN ('prepared', 'submit_in_flight') THEN
          RAISE EXCEPTION 'Supplier number cannot precede a supplier observation'
            USING ERRCODE = '23514', CONSTRAINT = 'procurement_operation_supplier_number_invalid';
        END IF;
        IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
          OLD.allocations_sealed AND NEW.allocations_sealed AND (
            (OLD.state = 'prepared' AND NEW.state IN ('submit_in_flight', 'rejected')) OR
            (OLD.state = 'submit_in_flight' AND NEW.state IN ('accepted_pending', 'unknown', 'manual_review', 'rejected', 'success_pending_finalize')) OR
            (OLD.state = 'accepted_pending' AND NEW.state IN ('unknown', 'manual_review', 'success_pending_finalize')) OR
            (OLD.state = 'unknown' AND NEW.state IN ('accepted_pending', 'manual_review', 'success_pending_finalize')) OR
            (OLD.state = 'manual_review' AND NEW.state IN ('accepted_pending', 'unknown', 'rejected', 'success_pending_finalize')) OR
            (OLD.state = 'success_pending_finalize' AND NEW.state IN ('manual_review', 'completed'))
          )) THEN
          RAISE EXCEPTION 'Illegal procurement operation transition'
            USING ERRCODE = '23514', CONSTRAINT = 'procurement_operation_state_transition';
        END IF;
        IF OLD.allocations_sealed = NEW.allocations_sealed AND OLD.state = NEW.state
          AND OLD.supplier_order_number IS NOT DISTINCT FROM NEW.supplier_order_number THEN
          RAISE EXCEPTION 'An operation revision requires a change'
            USING ERRCODE = '23514', CONSTRAINT = 'procurement_operation_noop';
        END IF;
        NEW.updated_at := clock_timestamp();
        RETURN NEW;
      END $$
    `.execute(db)
    await sql`CREATE TRIGGER procurement_operation_guard BEFORE INSERT OR UPDATE OR DELETE ON procurement_operations
      FOR EACH ROW EXECUTE FUNCTION guard_procurement_operation()`.execute(db)
    await sql`CREATE TRIGGER procurement_operation_no_truncate BEFORE TRUNCATE ON procurement_operations
      FOR EACH STATEMENT EXECUTE FUNCTION protect_order_purchase_immutable()`.execute(db)

    await sql`
      CREATE FUNCTION guard_procurement_unit() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE operation procurement_operations%ROWTYPE; item order_items%ROWTYPE;
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'Procurement unit assignments are permanent' USING ERRCODE = '23514', CONSTRAINT = 'procurement_unit_immutable';
        END IF;
        SELECT * INTO operation FROM procurement_operations WHERE id = NEW.operation_id FOR UPDATE;
        SELECT * INTO item FROM order_items WHERE id = NEW.order_item_id;
        IF TG_OP = 'INSERT' THEN
          IF operation.id IS NULL OR operation.allocations_sealed OR operation.order_item_id <> NEW.order_item_id
            OR item.id IS NULL OR NEW.unit_index < 1 OR NEW.unit_index > item.quantity OR NEW.state <> 'allocated'
            OR EXISTS (SELECT 1 FROM order_item_fulfillment_deliveries delivery
              JOIN order_item_fulfillment_attempts attempt ON attempt.id = delivery.fulfillment_attempt_id
              WHERE attempt.order_item_id = item.id AND attempt.status <> 'failed' AND delivery.unit_index = NEW.unit_index) THEN
            RAISE EXCEPTION 'Procurement unit must belong to the unsealed operation and an undelivered order unit'
              USING ERRCODE = '23514', CONSTRAINT = 'procurement_unit_identity_invalid';
          END IF;
          RETURN NEW;
        END IF;
        IF ROW(NEW.operation_id, NEW.order_item_id, NEW.unit_index, NEW.created_at)
          IS DISTINCT FROM ROW(OLD.operation_id, OLD.order_item_id, OLD.unit_index, OLD.created_at)
          OR OLD.state IN ('completed', 'rejected') OR NEW.state = OLD.state
          OR NOT (
            (NEW.state = 'unknown' AND operation.state = 'unknown' AND OLD.state IN ('allocated', 'manual_review')) OR
            (NEW.state = 'manual_review' AND operation.state = 'manual_review' AND OLD.state IN ('allocated', 'unknown', 'success_pending_finalize')) OR
            (NEW.state = 'success_pending_finalize' AND operation.state = 'success_pending_finalize' AND OLD.state IN ('allocated', 'unknown', 'manual_review')) OR
            (NEW.state = 'rejected' AND operation.state = 'rejected' AND OLD.state IN ('allocated', 'unknown', 'manual_review')) OR
            (NEW.state = 'completed' AND operation.state = 'success_pending_finalize' AND OLD.state = 'success_pending_finalize'
              AND EXISTS (SELECT 1 FROM order_item_fulfillment_deliveries delivery
                JOIN order_item_fulfillment_attempts attempt ON attempt.id = delivery.fulfillment_attempt_id
                WHERE attempt.order_item_id = NEW.order_item_id AND attempt.status = 'succeeded' AND delivery.unit_index = NEW.unit_index))
          ) THEN
          RAISE EXCEPTION 'Illegal procurement unit identity or state transition'
            USING ERRCODE = '23514', CONSTRAINT = 'procurement_unit_transition_invalid';
        END IF;
        RETURN NEW;
      END $$
    `.execute(db)
    await sql`CREATE TRIGGER procurement_unit_guard BEFORE INSERT OR UPDATE OR DELETE ON procurement_operation_units
      FOR EACH ROW EXECUTE FUNCTION guard_procurement_unit()`.execute(db)
    await sql`CREATE TRIGGER procurement_unit_no_truncate BEFORE TRUNCATE ON procurement_operation_units
      FOR EACH STATEMENT EXECUTE FUNCTION protect_order_purchase_immutable()`.execute(db)

    await sql`
      CREATE FUNCTION append_procurement_operation_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        INSERT INTO procurement_operation_events(operation_id, previous_state, next_state, revision, supplier_order_number)
        VALUES (NEW.id, CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.state END,
          NEW.state, NEW.revision, NEW.supplier_order_number);
        RETURN NEW;
      END $$
    `.execute(db)
    await sql`CREATE TRIGGER procurement_operation_event AFTER INSERT OR UPDATE ON procurement_operations
      FOR EACH ROW EXECUTE FUNCTION append_procurement_operation_event()`.execute(db)
    await sql`CREATE TRIGGER procurement_events_immutable BEFORE UPDATE OR DELETE ON procurement_operation_events
      FOR EACH ROW EXECUTE FUNCTION protect_order_purchase_immutable()`.execute(db)
    await sql`CREATE TRIGGER procurement_events_no_truncate BEFORE TRUNCATE ON procurement_operation_events
      FOR EACH STATEMENT EXECUTE FUNCTION protect_order_purchase_immutable()`.execute(db)
    await sql`
      CREATE FUNCTION append_procurement_unit_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        INSERT INTO procurement_unit_events(operation_id, unit_index, previous_state, next_state)
        VALUES (NEW.operation_id, NEW.unit_index, CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.state END, NEW.state);
        RETURN NEW;
      END $$
    `.execute(db)
    await sql`CREATE TRIGGER procurement_unit_event AFTER INSERT OR UPDATE ON procurement_operation_units
      FOR EACH ROW EXECUTE FUNCTION append_procurement_unit_event()`.execute(db)
    await sql`CREATE TRIGGER procurement_unit_events_immutable BEFORE UPDATE OR DELETE ON procurement_unit_events
      FOR EACH ROW EXECUTE FUNCTION protect_order_purchase_immutable()`.execute(db)
    await sql`CREATE TRIGGER procurement_unit_events_no_truncate BEFORE TRUNCATE ON procurement_unit_events
      FOR EACH STATEMENT EXECUTE FUNCTION protect_order_purchase_immutable()`.execute(db)
    await sql`
      CREATE FUNCTION guard_procurement_history_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF pg_trigger_depth() < 2 THEN
          RAISE EXCEPTION 'Procurement history is written only by identity transitions'
            USING ERRCODE = '23514', CONSTRAINT = 'procurement_history_insert_invalid';
        END IF;
        RETURN NEW;
      END $$
    `.execute(db)
    await sql`CREATE TRIGGER procurement_event_insert_guard BEFORE INSERT ON procurement_operation_events
      FOR EACH ROW EXECUTE FUNCTION guard_procurement_history_insert()`.execute(db)
    await sql`CREATE TRIGGER procurement_unit_event_insert_guard BEFORE INSERT ON procurement_unit_events
      FOR EACH ROW EXECUTE FUNCTION guard_procurement_history_insert()`.execute(db)

    await sql`
      CREATE FUNCTION assert_procurement_operation_complete() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE op procurement_operations%ROWTYPE;
      BEGIN
        IF TG_TABLE_NAME = 'procurement_operations' THEN
          SELECT * INTO op FROM procurement_operations WHERE id = NEW.id;
        ELSE
          SELECT * INTO op FROM procurement_operations WHERE id = NEW.operation_id;
        END IF;
        IF op.id IS NULL OR NOT op.allocations_sealed OR NOT EXISTS (SELECT 1 FROM procurement_operation_units WHERE operation_id = op.id)
          OR (op.state = 'rejected' AND EXISTS (SELECT 1 FROM procurement_operation_units WHERE operation_id = op.id AND state <> 'rejected'))
          OR (op.state = 'completed' AND EXISTS (SELECT 1 FROM procurement_operation_units WHERE operation_id = op.id AND state <> 'completed')) THEN
          RAISE EXCEPTION 'Procurement operation requires sealed, consistent unit assignments'
            USING ERRCODE = '23514', CONSTRAINT = 'procurement_operation_units_incomplete';
        END IF;
        RETURN NULL;
      END $$
    `.execute(db)
    await sql`CREATE CONSTRAINT TRIGGER procurement_operation_units_complete AFTER INSERT OR UPDATE ON procurement_operations
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_procurement_operation_complete()`.execute(db)
    await sql`CREATE CONSTRAINT TRIGGER procurement_unit_operation_complete AFTER INSERT OR UPDATE ON procurement_operation_units
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_procurement_operation_complete()`.execute(db)
  },
  async down(db) {
    await sql`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM order_item_procurement_sources) OR EXISTS (SELECT 1 FROM procurement_operations) THEN
        RAISE EXCEPTION 'Cannot remove procurement identity history';
      END IF;
    END $$`.execute(db)
    await sql`
      CREATE OR REPLACE FUNCTION order_has_unresolved_fulfillment(order_uuid uuid) RETURNS boolean
      LANGUAGE sql STABLE AS $$
        SELECT EXISTS (SELECT 1 FROM order_items AS item WHERE item.order_id = order_uuid
          AND (item.fulfillment_reserved_quantity > 0 OR EXISTS (
            SELECT 1 FROM order_item_fulfillment_attempts AS attempt WHERE attempt.order_item_id = item.id
              AND attempt.status IN ('processing', 'unknown'))))
      $$
    `.execute(db)
    await sql`DROP TABLE procurement_unit_events`.execute(db)
    await sql`DROP TABLE procurement_operation_events`.execute(db)
    await sql`DROP TABLE procurement_operation_units`.execute(db)
    await sql`DROP TABLE procurement_operations`.execute(db)
    await sql`DROP TABLE order_item_procurement_sources`.execute(db)
    await sql`DROP FUNCTION assert_procurement_operation_complete()`.execute(db)
    await sql`DROP FUNCTION append_procurement_operation_event()`.execute(db)
    await sql`DROP FUNCTION append_procurement_unit_event()`.execute(db)
    await sql`DROP FUNCTION guard_procurement_history_insert()`.execute(db)
    await sql`DROP FUNCTION guard_procurement_unit()`.execute(db)
    await sql`DROP FUNCTION guard_procurement_operation()`.execute(db)
    await sql`DROP FUNCTION procurement_order_financially_eligible(uuid)`.execute(db)
    await sql`DROP FUNCTION guard_order_item_procurement_source()`.execute(db)
  },
}
