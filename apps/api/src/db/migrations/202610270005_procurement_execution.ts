import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

/** Internal evidence and fulfillment bindings; no provider or production entry point. */
export const procurementExecutionMigration: Migration = {
  async up(db) {
    await sql`
      CREATE TABLE procurement_execution_leases (
        operation_id uuid PRIMARY KEY REFERENCES procurement_operations(id) ON DELETE RESTRICT,
        lease_token uuid, lease_expires_at timestamptz,
        request_generation bigint NOT NULL DEFAULT 0 CHECK (request_generation >= 0),
        next_action_at timestamptz,
        CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL))
      );
      CREATE TABLE procurement_request_intents (
        id uuid PRIMARY KEY,
        operation_id uuid NOT NULL REFERENCES procurement_operations(id) ON DELETE RESTRICT,
        generation bigint NOT NULL CHECK (generation > 0),
        action varchar(8) NOT NULL CHECK (action IN ('submit', 'query')),
        request_identity varchar(64) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        UNIQUE (operation_id, generation),
        UNIQUE (operation_id, generation, action)
      );
      CREATE UNIQUE INDEX procurement_one_submit_intent ON procurement_request_intents(operation_id) WHERE action = 'submit';
      CREATE TABLE procurement_execution_evidence (
        id uuid PRIMARY KEY,
        operation_id uuid NOT NULL,
        generation bigint NOT NULL,
        action varchar(8) NOT NULL,
        kind varchar(24) NOT NULL CHECK (kind IN ('accepted', 'pending', 'success', 'rejected', 'unknown', 'not_found', 'identity_conflict', 'debit_confirmed', 'delivery_confirmed')),
        supplier_order_number varchar(200),
        request_identity varchar(64) NOT NULL,
        unit_indices integer[] NOT NULL DEFAULT '{}',
        response_digest char(64) NOT NULL CHECK (response_digest ~ '^[0-9a-f]{64}$'),
        amount_minor numeric(20,0), currency text,
        observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        FOREIGN KEY (operation_id, generation, action) REFERENCES procurement_request_intents(operation_id, generation, action) ON DELETE RESTRICT,
        CHECK (supplier_order_number IS NULL OR length(btrim(supplier_order_number)) BETWEEN 1 AND 200),
        CHECK ((kind IN ('debit_confirmed','rejected') AND amount_minor IS NOT NULL AND amount_minor >= 0 AND currency ~ '^[A-Z]{3}$')
          OR (kind <> 'debit_confirmed' AND amount_minor IS NULL AND currency IS NULL))
      );
      CREATE TABLE procurement_preparation_requests (
        request_id uuid PRIMARY KEY,
        operation_id uuid NOT NULL UNIQUE REFERENCES procurement_operations(id) ON DELETE RESTRICT,
        order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
        order_item_id uuid NOT NULL REFERENCES order_items(id) ON DELETE RESTRICT,
        unit_indices integer[] NOT NULL,
        currency varchar(3) NOT NULL,
        max_amount_minor numeric(20,0) NOT NULL CHECK (max_amount_minor > 0),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );
      CREATE TRIGGER procurement_preparation_immutable BEFORE UPDATE OR DELETE ON procurement_preparation_requests FOR EACH ROW EXECUTE FUNCTION protect_order_purchase_immutable();
      CREATE TRIGGER procurement_preparation_no_truncate BEFORE TRUNCATE ON procurement_preparation_requests FOR EACH STATEMENT EXECUTE FUNCTION protect_order_purchase_immutable();
      CREATE TABLE procurement_execution_conflicts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        operation_id uuid NOT NULL REFERENCES procurement_operations(id) ON DELETE RESTRICT,
        other_operation_id uuid NOT NULL REFERENCES procurement_operations(id) ON DELETE RESTRICT,
        evidence_id uuid NOT NULL REFERENCES procurement_execution_evidence(id) ON DELETE RESTRICT,
        reason varchar(24) NOT NULL CHECK (reason IN ('supplier_number', 'prior_unit_execution')),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CHECK (operation_id <> other_operation_id),
        UNIQUE (operation_id, other_operation_id, evidence_id, reason)
      );
      CREATE TRIGGER procurement_conflicts_immutable BEFORE UPDATE OR DELETE ON procurement_execution_conflicts FOR EACH ROW EXECUTE FUNCTION protect_order_purchase_immutable();
      CREATE TRIGGER procurement_conflicts_no_truncate BEFORE TRUNCATE ON procurement_execution_conflicts FOR EACH STATEMENT EXECUTE FUNCTION protect_order_purchase_immutable();
      CREATE INDEX procurement_evidence_number_idx ON procurement_execution_evidence(supplier_order_number) WHERE supplier_order_number IS NOT NULL;
      CREATE TRIGGER procurement_intents_immutable BEFORE UPDATE OR DELETE ON procurement_request_intents FOR EACH ROW EXECUTE FUNCTION protect_order_purchase_immutable();
      CREATE TRIGGER procurement_intents_no_truncate BEFORE TRUNCATE ON procurement_request_intents FOR EACH STATEMENT EXECUTE FUNCTION protect_order_purchase_immutable();
      CREATE TRIGGER procurement_evidence_immutable BEFORE UPDATE OR DELETE ON procurement_execution_evidence FOR EACH ROW EXECUTE FUNCTION protect_order_purchase_immutable();
      CREATE TRIGGER procurement_evidence_no_truncate BEFORE TRUNCATE ON procurement_execution_evidence FOR EACH STATEMENT EXECUTE FUNCTION protect_order_purchase_immutable();
    `.execute(db)
    await sql`
      CREATE OR REPLACE FUNCTION order_has_unresolved_fulfillment(order_uuid uuid) RETURNS boolean
      LANGUAGE sql STABLE AS $$
        SELECT EXISTS (SELECT 1 FROM order_items AS item WHERE item.order_id = order_uuid
          AND (item.fulfillment_reserved_quantity > 0 OR EXISTS (
            SELECT 1 FROM order_item_fulfillment_attempts AS attempt WHERE attempt.order_item_id = item.id
              AND attempt.status IN ('processing', 'unknown'))))
          OR EXISTS (SELECT 1 FROM procurement_operations AS operation
            JOIN order_items AS item ON item.id = operation.order_item_id
            WHERE item.order_id = order_uuid AND (operation.state NOT IN ('rejected', 'completed')
              OR (operation.state='rejected' AND EXISTS (SELECT 1 FROM procurement_execution_evidence evidence
                WHERE evidence.operation_id=operation.id AND evidence.kind IN ('success','debit_confirmed')))))
      $$;
      CREATE FUNCTION guard_procurement_preparation_request() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE op procurement_operations%ROWTYPE; source order_item_procurement_sources%ROWTYPE; risk procurement_risk_reservations%ROWTYPE; units integer[];
      BEGIN
        PERFORM id FROM orders WHERE id=NEW.order_id FOR UPDATE NOWAIT;
        SELECT * INTO op FROM procurement_operations WHERE id=NEW.operation_id;
        SELECT * INTO source FROM order_item_procurement_sources WHERE id=op.source_id;
        SELECT * INTO risk FROM procurement_risk_reservations WHERE operation_id=op.id;
        SELECT array_agg(unit_index ORDER BY unit_index) INTO units FROM procurement_operation_units WHERE operation_id=op.id;
        IF op.id IS NULL OR source.order_id IS DISTINCT FROM NEW.order_id OR op.order_item_id IS DISTINCT FROM NEW.order_item_id
          OR NOT op.allocations_sealed OR units IS DISTINCT FROM NEW.unit_indices
          OR risk.currency IS DISTINCT FROM NEW.currency OR risk.amount_minor IS DISTINCT FROM NEW.max_amount_minor
          OR NOT EXISTS (SELECT 1 FROM procurement_operations WHERE id=NEW.operation_id AND xmin=pg_current_xact_id()::text::xid)
          OR NOT EXISTS (SELECT 1 FROM procurement_risk_reservations WHERE operation_id=NEW.operation_id AND xmin=pg_current_xact_id()::text::xid) THEN
          RAISE EXCEPTION 'Preparation request must atomically match a new operation and its risk reservation' USING ERRCODE='23514', CONSTRAINT='procurement_preparation_request_invalid';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER procurement_preparation_guard BEFORE INSERT ON procurement_preparation_requests FOR EACH ROW EXECUTE FUNCTION guard_procurement_preparation_request();
      CREATE FUNCTION guard_procurement_execution_intent() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE op procurement_operations%ROWTYPE; lease procurement_execution_leases%ROWTYPE;
      BEGIN
        SELECT * INTO op FROM procurement_operations WHERE id = NEW.operation_id;
        SELECT * INTO lease FROM procurement_execution_leases WHERE operation_id = NEW.operation_id;
        IF op.id IS NULL OR op.local_business_number IS DISTINCT FROM NEW.request_identity
          OR lease.request_generation IS DISTINCT FROM NEW.generation OR lease.lease_token IS NULL
          OR lease.lease_expires_at <= clock_timestamp() OR NOT op.allocations_sealed
          OR (NEW.action = 'submit' AND (op.state <> 'prepared' OR EXISTS (SELECT 1 FROM procurement_request_intents WHERE operation_id = op.id)))
          OR (NEW.action = 'query' AND op.state NOT IN ('submit_in_flight','unknown','accepted_pending','manual_review','success_pending_finalize')) THEN
          RAISE EXCEPTION 'Invalid procurement request intent' USING ERRCODE = '23514', CONSTRAINT = 'procurement_intent_invalid';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER procurement_intent_guard BEFORE INSERT ON procurement_request_intents FOR EACH ROW EXECUTE FUNCTION guard_procurement_execution_intent();
      CREATE FUNCTION guard_procurement_execution_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE op procurement_operations%ROWTYPE; conn uuid; risk_currency text;
      BEGIN
        SELECT * INTO op FROM procurement_operations WHERE id = NEW.operation_id;
        PERFORM id FROM orders WHERE id=(SELECT order_id FROM order_item_procurement_sources WHERE id=op.source_id) FOR UPDATE NOWAIT;
        SELECT currency INTO risk_currency FROM procurement_risk_reservations WHERE operation_id=NEW.operation_id;
        IF risk_currency IS NOT NULL THEN
          PERFORM 1 FROM procurement_risk_policies WHERE currency=risk_currency FOR UPDATE NOWAIT;
        END IF;
        IF op.id IS NULL OR op.local_business_number IS DISTINCT FROM NEW.request_identity
          OR EXISTS (SELECT 1 FROM unnest(NEW.unit_indices) u WHERE u IS NULL OR NOT EXISTS
            (SELECT 1 FROM procurement_operation_units WHERE operation_id=op.id AND unit_index=u))
          OR cardinality(NEW.unit_indices) <> (SELECT count(DISTINCT u) FROM unnest(NEW.unit_indices) u)
          OR (NEW.kind IN ('success','delivery_confirmed') AND cardinality(NEW.unit_indices)=0)
          OR (NEW.kind='delivery_confirmed' AND EXISTS (SELECT 1 FROM unnest(NEW.unit_indices) u WHERE NOT EXISTS (
            SELECT 1 FROM procurement_execution_evidence success WHERE success.operation_id=NEW.operation_id
              AND success.kind='success' AND success.response_digest=NEW.response_digest
              AND success.supplier_order_number IS NOT DISTINCT FROM NEW.supplier_order_number AND u=ANY(success.unit_indices)))) THEN
          RAISE EXCEPTION 'Evidence has an invalid operation or unit identity' USING ERRCODE = '23514', CONSTRAINT = 'procurement_evidence_identity_invalid';
        END IF;
        IF NEW.supplier_order_number IS NOT NULL THEN
          SELECT supplier_connection_id INTO conn FROM order_item_procurement_sources WHERE id=op.source_id;
          PERFORM pg_advisory_xact_lock(hashtextextended('procurement-number:' || conn::text || ':' || NEW.supplier_order_number, 0));
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER procurement_evidence_guard BEFORE INSERT ON procurement_execution_evidence FOR EACH ROW EXECUTE FUNCTION guard_procurement_execution_evidence();
      CREATE FUNCTION procurement_evidence_record_conflicts() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE counterpart uuid;
      BEGIN
        FOR counterpart IN
          SELECT DISTINCT other.id FROM procurement_operations owner
          JOIN order_item_procurement_sources owner_source ON owner_source.id=owner.source_id
          JOIN order_item_procurement_sources other_source ON other_source.supplier_connection_id=owner_source.supplier_connection_id
          JOIN procurement_operations other ON other.source_id=other_source.id AND other.id<>owner.id
          JOIN procurement_execution_evidence prior ON prior.operation_id=other.id
          WHERE owner.id=NEW.operation_id AND NEW.supplier_order_number IS NOT NULL
            AND prior.supplier_order_number=NEW.supplier_order_number
        LOOP
          INSERT INTO procurement_execution_conflicts(operation_id,other_operation_id,evidence_id,reason)
            VALUES (NEW.operation_id,counterpart,NEW.id,'supplier_number'),(counterpart,NEW.operation_id,NEW.id,'supplier_number')
            ON CONFLICT DO NOTHING;
        END LOOP;
        IF NEW.kind IN ('success','debit_confirmed') THEN
          FOR counterpart IN
            SELECT DISTINCT other_unit.operation_id FROM procurement_operation_units mine
            JOIN procurement_operation_units other_unit ON other_unit.order_item_id=mine.order_item_id
              AND other_unit.unit_index=mine.unit_index AND other_unit.operation_id<>mine.operation_id
            WHERE mine.operation_id=NEW.operation_id AND other_unit.state<>'rejected'
              AND (NEW.kind='debit_confirmed' OR mine.unit_index=ANY(NEW.unit_indices))
          LOOP
            INSERT INTO procurement_execution_conflicts(operation_id,other_operation_id,evidence_id,reason)
              VALUES (NEW.operation_id,counterpart,NEW.id,'prior_unit_execution'),(counterpart,NEW.operation_id,NEW.id,'prior_unit_execution')
              ON CONFLICT DO NOTHING;
          END LOOP;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER procurement_evidence_conflicts AFTER INSERT ON procurement_execution_evidence FOR EACH ROW EXECUTE FUNCTION procurement_evidence_record_conflicts();
      CREATE FUNCTION guard_procurement_conflict_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF pg_trigger_depth()<2 THEN
          RAISE EXCEPTION 'Conflict facts are generated from evidence' USING ERRCODE='23514', CONSTRAINT='procurement_conflict_insert_invalid';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER procurement_conflict_insert_guard BEFORE INSERT ON procurement_execution_conflicts FOR EACH ROW EXECUTE FUNCTION guard_procurement_conflict_insert();
      CREATE FUNCTION procurement_evidence_restore_risk() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.kind IN ('success','debit_confirmed') THEN
          PERFORM procurement_risk_reinstate_from_evidence(NEW.id);
        END IF;
        PERFORM procurement_risk_note_from_evidence(NEW.id);
        RETURN NEW;
      END $$;
      CREATE TRIGGER procurement_evidence_restore_risk AFTER INSERT ON procurement_execution_evidence FOR EACH ROW EXECUTE FUNCTION procurement_evidence_restore_risk();
      CREATE FUNCTION procurement_record_review_risk() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        PERFORM procurement_risk_note_from_review(NEW.operation_id, NEW.revision);
        RETURN NEW;
      END $$;
      CREATE TRIGGER procurement_review_risk AFTER INSERT ON procurement_operation_events FOR EACH ROW EXECUTE FUNCTION procurement_record_review_risk();
      CREATE FUNCTION procurement_unit_has_prior_execution(operation_uuid uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT EXISTS (SELECT 1 FROM procurement_operation_units current_unit
          JOIN procurement_operation_units other_unit ON other_unit.order_item_id=current_unit.order_item_id
            AND other_unit.unit_index=current_unit.unit_index AND other_unit.operation_id<>current_unit.operation_id
          JOIN procurement_execution_evidence evidence ON evidence.operation_id=other_unit.operation_id
          WHERE current_unit.operation_id=operation_uuid AND
            (evidence.kind='debit_confirmed' OR (evidence.kind='success' AND current_unit.unit_index=ANY(evidence.unit_indices))))
      $$;
      CREATE FUNCTION guard_procurement_evidence_transition() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE risk procurement_risk_reservations%ROWTYPE; paused boolean;
      BEGIN
        IF NEW.state IS DISTINCT FROM OLD.state AND NEW.state IN ('rejected','success_pending_finalize')
          AND NOT EXISTS (SELECT 1 FROM procurement_execution_evidence e WHERE e.operation_id=NEW.id
            AND e.kind = CASE NEW.state WHEN 'rejected' THEN 'rejected' ELSE 'success' END
            AND (NEW.supplier_order_number IS NULL OR e.supplier_order_number = NEW.supplier_order_number)) THEN
          RAISE EXCEPTION 'Procurement result requires matching evidence' USING ERRCODE = '23514', CONSTRAINT = 'procurement_state_evidence_required';
        END IF;
        IF NEW.supplier_order_number IS DISTINCT FROM OLD.supplier_order_number AND NEW.supplier_order_number IS NOT NULL AND EXISTS (
          SELECT 1 FROM procurement_execution_evidence WHERE operation_id=NEW.id AND supplier_order_number IS NOT NULL
            AND supplier_order_number<>NEW.supplier_order_number) THEN
          RAISE EXCEPTION 'Conflicting supplier numbers require review' USING ERRCODE='23514', CONSTRAINT='procurement_number_evidence_conflict';
        END IF;
        IF NEW.supplier_order_number IS DISTINCT FROM OLD.supplier_order_number AND NEW.supplier_order_number IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM procurement_execution_evidence WHERE operation_id=NEW.id AND supplier_order_number=NEW.supplier_order_number AND kind<>'identity_conflict') THEN
          RAISE EXCEPTION 'Supplier number requires attributable evidence' USING ERRCODE='23514', CONSTRAINT='procurement_number_evidence_required';
        END IF;
        IF NEW.state='accepted_pending' AND OLD.state<>NEW.state AND NOT EXISTS (SELECT 1 FROM procurement_execution_evidence
          WHERE operation_id=NEW.id AND kind IN ('accepted','pending') AND supplier_order_number=NEW.supplier_order_number) THEN
          RAISE EXCEPTION 'Acceptance requires evidence' USING ERRCODE='23514', CONSTRAINT='procurement_state_evidence_required';
        END IF;
        IF NEW.state='rejected' AND OLD.state<>NEW.state AND (EXISTS (SELECT 1 FROM procurement_execution_evidence
            WHERE operation_id=NEW.id AND kind IN ('success','debit_confirmed')) OR NOT EXISTS (
          SELECT 1 FROM procurement_risk_reservations r JOIN procurement_risk_events e ON e.operation_id=r.operation_id
            JOIN procurement_execution_evidence fact ON fact.id=e.evidence_id
          WHERE r.operation_id=NEW.id AND e.kind='release' AND e.amount_minor=r.amount_minor AND fact.kind='rejected'
            AND fact.operation_id=NEW.id AND fact.amount_minor=r.amount_minor AND fact.currency=r.currency)) THEN
          RAISE EXCEPTION 'Rejection requires nonexecution evidence and full risk release' USING ERRCODE='23514', CONSTRAINT='procurement_rejection_risk_required';
        END IF;
        IF NEW.state='submit_in_flight' AND OLD.state='prepared' THEN
          PERFORM id FROM orders WHERE id=(SELECT order_id FROM order_item_procurement_sources WHERE id=NEW.source_id) FOR UPDATE NOWAIT;
          IF procurement_unit_has_prior_execution(NEW.id) THEN
            RAISE EXCEPTION 'Earlier procurement execution requires manual review' USING ERRCODE='23514', CONSTRAINT='procurement_prior_execution_conflict';
          END IF;
          SELECT * INTO risk FROM procurement_risk_reservations WHERE operation_id=NEW.id;
          IF risk.operation_id IS NULL OR NOT EXISTS (SELECT 1 FROM procurement_preparation_requests WHERE operation_id=NEW.id) THEN
            RAISE EXCEPTION 'Submission requires reserved risk and its preparation identity' USING ERRCODE='23514', CONSTRAINT='procurement_submit_budget_required';
          END IF;
          SELECT policy.paused INTO paused FROM procurement_risk_policies policy WHERE policy.currency=risk.currency FOR UPDATE NOWAIT;
          IF paused IS DISTINCT FROM false OR NOT EXISTS (SELECT 1 FROM procurement_risk_events
            WHERE operation_id=NEW.id AND kind='reserve' AND amount_minor=risk.amount_minor)
            OR EXISTS (SELECT 1 FROM procurement_risk_events WHERE operation_id=NEW.id AND kind IN ('debit','release')) THEN
            RAISE EXCEPTION 'Submission requires active reserved risk' USING ERRCODE='23514', CONSTRAINT='procurement_submit_budget_required';
          END IF;
        END IF;
        IF NEW.state='submit_in_flight' AND OLD.state='prepared' AND (NOT EXISTS
          (SELECT 1 FROM procurement_request_intents WHERE operation_id=NEW.id AND action='submit')
          OR NOT procurement_order_financially_eligible((SELECT order_id FROM order_item_procurement_sources WHERE id=NEW.source_id))) THEN
          RAISE EXCEPTION 'Submission requires intent and financial eligibility' USING ERRCODE = '23514', CONSTRAINT = 'procurement_submit_ineligible';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER procurement_state_evidence_guard BEFORE UPDATE ON procurement_operations FOR EACH ROW EXECUTE FUNCTION guard_procurement_evidence_transition();
      CREATE FUNCTION guard_procurement_unit_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.state='success_pending_finalize' AND OLD.state<>NEW.state AND NOT EXISTS
          (SELECT 1 FROM procurement_execution_evidence WHERE operation_id=NEW.operation_id AND kind='success' AND NEW.unit_index=ANY(unit_indices)) THEN
          RAISE EXCEPTION 'Unit success requires evidence' USING ERRCODE='23514', CONSTRAINT='procurement_unit_evidence_required';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER procurement_unit_evidence_guard BEFORE UPDATE ON procurement_operation_units FOR EACH ROW EXECUTE FUNCTION guard_procurement_unit_evidence();
    `.execute(db)
    await sql`
      ALTER TABLE procurement_risk_events ADD CONSTRAINT procurement_risk_event_evidence_fkey
        FOREIGN KEY (evidence_id) REFERENCES procurement_execution_evidence(id) ON DELETE RESTRICT;
      ALTER TABLE order_item_fulfillment_attempts
        ADD COLUMN procurement_operation_id uuid,
        ADD COLUMN procurement_unit_index integer,
        ADD CONSTRAINT fulfillment_attempt_procurement_unit_fkey FOREIGN KEY (procurement_operation_id, procurement_unit_index)
          REFERENCES procurement_operation_units(operation_id, unit_index) ON DELETE RESTRICT,
        ADD CONSTRAINT fulfillment_attempt_procurement_shape CHECK (
          (delivery_source='procurement' AND procurement_operation_id IS NOT NULL AND procurement_unit_index IS NOT NULL AND quantity=1 AND started_by_admin_id IS NULL)
          OR (delivery_source<>'procurement' AND procurement_operation_id IS NULL AND procurement_unit_index IS NULL));
      CREATE UNIQUE INDEX fulfillment_attempt_procurement_unit_unique ON order_item_fulfillment_attempts(procurement_operation_id,procurement_unit_index)
        WHERE procurement_operation_id IS NOT NULL;
      ALTER TABLE order_item_fulfillment_attempts DROP CONSTRAINT order_item_fulfillment_attempts_source_check;
      ALTER TABLE order_item_fulfillment_attempts ADD CONSTRAINT order_item_fulfillment_attempts_source_check
        CHECK (delivery_source IN ('manual','code_pool','fixed_content','link','file','api','procurement'));
      ALTER TABLE order_item_fulfillment_deliveries DROP CONSTRAINT order_item_fulfillment_deliveries_source_check;
      ALTER TABLE order_item_fulfillment_deliveries ADD CONSTRAINT order_item_fulfillment_deliveries_source_check
        CHECK (delivery_source IN ('manual','code_pool','fixed_content','link','file','api','procurement'));
      DO $$ DECLARE old_check text; BEGIN
        SELECT pg_get_constraintdef(oid) INTO old_check FROM pg_constraint
          WHERE conrelid='order_item_fulfillment_deliveries'::regclass AND conname='order_item_fulfillment_deliveries_content_check';
        ALTER TABLE order_item_fulfillment_deliveries DROP CONSTRAINT order_item_fulfillment_deliveries_content_check;
        EXECUTE 'ALTER TABLE order_item_fulfillment_deliveries ADD CONSTRAINT order_item_fulfillment_deliveries_content_check CHECK ('
          || substring(old_check FROM 7) || ' OR (delivery_source = ''procurement'' AND started_by_admin_id IS NULL AND content IS NULL '
          || 'AND encrypted_content IS NULL AND content_nonce IS NULL AND content_auth_tag IS NULL AND encryption_key_id IS NULL '
          || 'AND code_pool_entry_id IS NULL AND fulfillment_content_version_id IS NULL AND supplier_api_operation_id IS NULL '
          || 'AND supplier_connection_id IS NULL AND supplier_product_id IS NULL AND supplier_content_type IS NULL AND supplier_fingerprint_key_id IS NULL))';
      END $$;
      -- Preserve all existing branches; admit the internal procurement source, whose
      -- stricter identity and evidence rules are checked by separate guards below.
      DO $$ DECLARE src text; rewritten text; BEGIN
        SELECT pg_get_functiondef('guard_code_pool_fulfillment_attempt()'::regprocedure) INTO src;
        rewritten := replace(src, 'IF NEW.delivery_source IS DISTINCT FROM method_name',
          'IF (NEW.delivery_source IS DISTINCT FROM method_name AND NEW.delivery_source <> ''procurement'')');
        IF rewritten=src THEN RAISE EXCEPTION 'Unable to extend fulfillment attempt guard'; END IF;
        EXECUTE rewritten;
        SELECT pg_get_functiondef('guard_procurement_operation()'::regprocedure) INTO src;
        rewritten := replace(src, '(OLD.state = ''prepared'' AND NEW.state IN (''submit_in_flight'', ''rejected''))',
          '(OLD.state = ''prepared'' AND NEW.state IN (''submit_in_flight'', ''rejected'', ''manual_review''))');
        IF rewritten=src THEN RAISE EXCEPTION 'Unable to extend procurement review guard'; END IF;
        EXECUTE rewritten;
        SELECT pg_get_functiondef('guard_code_pool_delivery_record()'::regprocedure) INTO src;
        rewritten := replace(src, 'IF NEW.delivery_source = ''manual'' THEN',
          'IF NEW.delivery_source = ''procurement'' THEN RETURN NEW; END IF; IF NEW.delivery_source = ''manual'' THEN');
        IF rewritten=src THEN RAISE EXCEPTION 'Unable to extend fulfillment delivery guard'; END IF;
        EXECUTE rewritten;
        SELECT pg_get_functiondef('guard_manual_fulfillment_delivery_success()'::regprocedure) INTO src;
        rewritten := replace(src, 'IF fulfillment_method = ''manual'' THEN',
          'IF fulfillment_method = ''manual'' AND NEW.delivery_source = ''manual'' THEN');
        IF rewritten=src THEN RAISE EXCEPTION 'Unable to extend manual success guard'; END IF;
        EXECUTE rewritten;
      END $$;
    `.execute(db)
    await sql`
      CREATE FUNCTION procurement_number_has_collision(operation_uuid uuid) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
      DECLARE conn uuid; number text;
      BEGIN
        SELECT source.supplier_connection_id, operation.supplier_order_number INTO conn, number
        FROM procurement_operations operation JOIN order_item_procurement_sources source ON source.id=operation.source_id WHERE operation.id=operation_uuid;
        IF number IS NULL THEN RETURN false; END IF;
        PERFORM pg_advisory_xact_lock(hashtextextended('procurement-number:' || conn::text || ':' || number, 0));
        RETURN EXISTS (SELECT 1 FROM procurement_execution_evidence evidence WHERE evidence.operation_id=operation_uuid
          AND evidence.supplier_order_number IS NOT NULL AND evidence.supplier_order_number<>number)
          OR EXISTS (SELECT 1 FROM procurement_execution_evidence evidence
          JOIN procurement_operations other ON other.id=evidence.operation_id
          JOIN order_item_procurement_sources source ON source.id=other.source_id
          WHERE other.id<>operation_uuid AND source.supplier_connection_id=conn AND evidence.supplier_order_number=number);
      END $$;
      CREATE FUNCTION guard_procurement_fulfillment_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE parent_id uuid; operation procurement_operations%ROWTYPE;
      BEGIN
        IF TG_OP='UPDATE' AND ROW(NEW.procurement_operation_id,NEW.procurement_unit_index)
          IS DISTINCT FROM ROW(OLD.procurement_operation_id,OLD.procurement_unit_index) THEN
          RAISE EXCEPTION 'Procurement fulfillment identity is permanent' USING ERRCODE='23514', CONSTRAINT='procurement_fulfillment_identity_immutable';
        END IF;
        SELECT order_id INTO parent_id FROM order_items WHERE id=NEW.order_item_id;
        PERFORM id FROM orders WHERE id=parent_id FOR UPDATE;
        PERFORM id FROM order_items WHERE id=NEW.order_item_id FOR UPDATE;
        IF NEW.delivery_source <> 'procurement' THEN
          IF TG_OP='INSERT' AND EXISTS (SELECT 1 FROM procurement_operation_units
            WHERE order_item_id=NEW.order_item_id AND (state NOT IN ('rejected','completed')
              OR (state='rejected' AND EXISTS (SELECT 1 FROM procurement_execution_evidence evidence
                WHERE evidence.operation_id=procurement_operation_units.operation_id
                  AND (evidence.kind='debit_confirmed' OR (evidence.kind='success' AND procurement_operation_units.unit_index=ANY(evidence.unit_indices))))))) THEN
            RAISE EXCEPTION 'An active procurement obligation blocks competing fulfillment' USING ERRCODE='23514', CONSTRAINT='procurement_fulfillment_conflict';
          END IF;
          RETURN NEW;
        END IF;
        SELECT * INTO operation FROM procurement_operations WHERE id=NEW.procurement_operation_id;
        IF operation.id IS NULL OR operation.order_item_id<>NEW.order_item_id OR operation.state<>'success_pending_finalize' OR operation.supplier_order_number IS NULL
          OR NOT EXISTS (SELECT 1 FROM procurement_operation_units WHERE operation_id=operation.id AND unit_index=NEW.procurement_unit_index AND state='success_pending_finalize')
          OR NOT EXISTS (SELECT 1 FROM procurement_execution_evidence WHERE operation_id=operation.id AND kind='delivery_confirmed' AND NEW.procurement_unit_index=ANY(unit_indices)
            AND (supplier_order_number IS NULL OR supplier_order_number=operation.supplier_order_number))
          OR NOT procurement_order_financially_eligible(parent_id) OR procurement_number_has_collision(operation.id)
          OR procurement_unit_has_prior_execution(operation.id) THEN
          RAISE EXCEPTION 'Procurement fulfillment requires eligible, unique confirmed success' USING ERRCODE='23514', CONSTRAINT='procurement_fulfillment_unverified';
        END IF;
        IF TG_OP='UPDATE' AND NEW.status='succeeded' AND OLD.status<>'succeeded' AND NOT EXISTS (
          SELECT 1 FROM order_item_fulfillment_deliveries d JOIN procurement_execution_evidence e
            ON e.operation_id=operation.id AND e.kind='delivery_confirmed' AND NEW.procurement_unit_index=ANY(e.unit_indices)
              AND (e.supplier_order_number IS NULL OR e.supplier_order_number=operation.supplier_order_number)
          WHERE d.fulfillment_attempt_id=NEW.id AND d.delivery_source='procurement' AND d.unit_index=NEW.procurement_unit_index
            AND d.content_sha256=e.response_digest AND NEW.result_sha256=e.response_digest) THEN
          RAISE EXCEPTION 'Procurement fulfillment requires its evidenced delivery' USING ERRCODE='23514', CONSTRAINT='procurement_fulfillment_delivery_required';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER procurement_fulfillment_attempt_guard BEFORE INSERT OR UPDATE ON order_item_fulfillment_attempts FOR EACH ROW EXECUTE FUNCTION guard_procurement_fulfillment_attempt();
      CREATE FUNCTION guard_procurement_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE attempt order_item_fulfillment_attempts%ROWTYPE; parent_id uuid;
      BEGIN
        SELECT * INTO attempt FROM order_item_fulfillment_attempts WHERE id=NEW.fulfillment_attempt_id;
        SELECT order_id INTO parent_id FROM order_items WHERE id=attempt.order_item_id;
        PERFORM id FROM orders WHERE id=parent_id FOR UPDATE;
        PERFORM id FROM order_items WHERE id=attempt.order_item_id FOR UPDATE;
        IF NEW.delivery_source='procurement' THEN
          IF attempt.delivery_source<>'procurement' OR attempt.procurement_unit_index<>NEW.unit_index
            OR procurement_number_has_collision(attempt.procurement_operation_id)
            OR NOT EXISTS (SELECT 1 FROM procurement_execution_evidence WHERE operation_id=attempt.procurement_operation_id
              AND kind='delivery_confirmed' AND NEW.unit_index=ANY(unit_indices) AND response_digest=NEW.content_sha256
              AND (supplier_order_number IS NULL OR supplier_order_number=(SELECT supplier_order_number FROM procurement_operations WHERE id=attempt.procurement_operation_id))) THEN
            RAISE EXCEPTION 'Procurement delivery requires matching success evidence' USING ERRCODE='23514', CONSTRAINT='procurement_delivery_evidence_required';
          END IF;
        ELSIF EXISTS (SELECT 1 FROM procurement_operation_units unit WHERE unit.order_item_id=attempt.order_item_id AND unit.unit_index=NEW.unit_index
          AND (unit.state<>'rejected' OR EXISTS (SELECT 1 FROM procurement_execution_evidence evidence WHERE evidence.operation_id=unit.operation_id
            AND (evidence.kind='debit_confirmed' OR (evidence.kind='success' AND unit.unit_index=ANY(evidence.unit_indices)))))) THEN
          RAISE EXCEPTION 'Unit belongs to procurement' USING ERRCODE='23514', CONSTRAINT='procurement_delivery_conflict';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER procurement_delivery_guard BEFORE INSERT ON order_item_fulfillment_deliveries FOR EACH ROW EXECUTE FUNCTION guard_procurement_delivery();
      CREATE FUNCTION procurement_new_unit_record_prior_conflicts() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE fact record;
      BEGIN
        FOR fact IN SELECT evidence.id, other.operation_id FROM procurement_operation_units other
          JOIN procurement_execution_evidence evidence ON evidence.operation_id=other.operation_id
          WHERE other.order_item_id=NEW.order_item_id AND other.unit_index=NEW.unit_index
            AND other.operation_id<>NEW.operation_id
            AND (evidence.kind='debit_confirmed' OR (evidence.kind='success' AND NEW.unit_index=ANY(evidence.unit_indices)))
        LOOP
          INSERT INTO procurement_execution_conflicts(operation_id,other_operation_id,evidence_id,reason)
            VALUES (NEW.operation_id,fact.operation_id,fact.id,'prior_unit_execution'),
              (fact.operation_id,NEW.operation_id,fact.id,'prior_unit_execution') ON CONFLICT DO NOTHING;
        END LOOP;
        RETURN NEW;
      END $$;
      CREATE TRIGGER procurement_new_unit_conflicts AFTER INSERT ON procurement_operation_units FOR EACH ROW EXECUTE FUNCTION procurement_new_unit_record_prior_conflicts();
      CREATE FUNCTION guard_procurement_unit_binding() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP='INSERT' THEN
          PERFORM id FROM orders WHERE id=(SELECT order_id FROM order_items WHERE id=NEW.order_item_id) FOR UPDATE NOWAIT;
        END IF;
        IF TG_OP='INSERT' AND EXISTS (SELECT 1 FROM order_item_fulfillment_attempts WHERE order_item_id=NEW.order_item_id AND status IN ('processing','unknown')) THEN
          RAISE EXCEPTION 'Active fulfillment conflicts with procurement' USING ERRCODE='23514', CONSTRAINT='procurement_fulfillment_conflict';
        END IF;
        IF TG_OP='UPDATE' AND NEW.state='completed' AND NOT EXISTS (
          SELECT 1 FROM order_item_fulfillment_attempts a JOIN order_item_fulfillment_deliveries d ON d.fulfillment_attempt_id=a.id
          WHERE a.procurement_operation_id=NEW.operation_id AND a.procurement_unit_index=NEW.unit_index
            AND a.order_item_id=NEW.order_item_id AND a.status='succeeded' AND d.delivery_source='procurement' AND d.unit_index=NEW.unit_index) THEN
          RAISE EXCEPTION 'Completed unit requires its own procurement delivery' USING ERRCODE='23514', CONSTRAINT='procurement_unit_delivery_required';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER procurement_unit_binding_guard BEFORE INSERT OR UPDATE ON procurement_operation_units FOR EACH ROW EXECUTE FUNCTION guard_procurement_unit_binding();
      CREATE FUNCTION guard_procurement_completion_collision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.state='completed' AND OLD.state<>NEW.state AND (procurement_number_has_collision(NEW.id) OR procurement_unit_has_prior_execution(NEW.id)) THEN
          RAISE EXCEPTION 'Supplier number collision requires manual review' USING ERRCODE='23514', CONSTRAINT='procurement_supplier_number_collision';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER procurement_completion_collision_guard BEFORE UPDATE ON procurement_operations FOR EACH ROW EXECUTE FUNCTION guard_procurement_completion_collision();
    `.execute(db)
  },
  async down() {
    throw new Error('Procurement execution evidence and delivery identities are permanent; this migration is forward-only.')
  },
}
