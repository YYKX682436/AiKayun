import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

/** Conflicting identities remain unresolved until a future audited resolution protocol exists. */
export const procurementIdentityConflictGuardMigration: Migration = {
  async up(db) {
    await sql`
      CREATE FUNCTION procurement_has_identity_conflict(operation_uuid uuid) RETURNS boolean
      LANGUAGE sql VOLATILE AS $$
        SELECT EXISTS (SELECT 1 FROM procurement_execution_evidence
          WHERE operation_id=operation_uuid AND kind='identity_conflict')
      $$;
      CREATE OR REPLACE FUNCTION procurement_unit_has_prior_execution(operation_uuid uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
        SELECT EXISTS (SELECT 1 FROM procurement_operation_units current_unit
          JOIN procurement_operation_units other_unit ON other_unit.order_item_id=current_unit.order_item_id
            AND other_unit.unit_index=current_unit.unit_index AND other_unit.operation_id<>current_unit.operation_id
          JOIN procurement_execution_evidence evidence ON evidence.operation_id=other_unit.operation_id
          WHERE current_unit.operation_id=operation_uuid AND
            (evidence.kind IN ('debit_confirmed','identity_conflict')
              OR (evidence.kind='success' AND current_unit.unit_index=ANY(evidence.unit_indices))))
      $$;
      CREATE OR REPLACE FUNCTION order_has_unresolved_fulfillment(order_uuid uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
        SELECT EXISTS (SELECT 1 FROM order_items item WHERE item.order_id=order_uuid
          AND (item.fulfillment_reserved_quantity>0 OR EXISTS (SELECT 1 FROM order_item_fulfillment_attempts attempt
            WHERE attempt.order_item_id=item.id AND attempt.status IN ('processing','unknown'))))
          OR EXISTS (SELECT 1 FROM procurement_operations operation JOIN order_items item ON item.id=operation.order_item_id
            WHERE item.order_id=order_uuid AND (operation.state NOT IN ('rejected','completed')
              OR procurement_has_identity_conflict(operation.id)
              OR (operation.state='rejected' AND EXISTS (SELECT 1 FROM procurement_execution_evidence evidence
                WHERE evidence.operation_id=operation.id AND evidence.kind IN ('success','debit_confirmed')))))
      $$;
      CREATE FUNCTION record_identity_conflict_reallocations() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE counterpart uuid;
      BEGIN
        IF NEW.kind='identity_conflict' THEN
          FOR counterpart IN SELECT DISTINCT other.operation_id FROM procurement_operation_units mine
            JOIN procurement_operation_units other ON other.order_item_id=mine.order_item_id AND other.unit_index=mine.unit_index
              AND other.operation_id<>mine.operation_id
            WHERE mine.operation_id=NEW.operation_id AND other.state<>'rejected'
          LOOP
            INSERT INTO procurement_execution_conflicts(operation_id,other_operation_id,evidence_id,reason)
              VALUES (NEW.operation_id,counterpart,NEW.id,'prior_unit_execution'),
                (counterpart,NEW.operation_id,NEW.id,'prior_unit_execution') ON CONFLICT DO NOTHING;
          END LOOP;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER procurement_identity_conflict_reallocations AFTER INSERT ON procurement_execution_evidence
        FOR EACH ROW EXECUTE FUNCTION record_identity_conflict_reallocations();
      CREATE FUNCTION record_reallocation_after_identity_conflict() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE fact record;
      BEGIN
        FOR fact IN SELECT evidence.id, other.operation_id FROM procurement_operation_units other
          JOIN procurement_execution_evidence evidence ON evidence.operation_id=other.operation_id
          WHERE other.order_item_id=NEW.order_item_id AND other.unit_index=NEW.unit_index
            AND other.operation_id<>NEW.operation_id AND evidence.kind='identity_conflict'
        LOOP
          INSERT INTO procurement_execution_conflicts(operation_id,other_operation_id,evidence_id,reason)
            VALUES (NEW.operation_id,fact.operation_id,fact.id,'prior_unit_execution'),
              (fact.operation_id,NEW.operation_id,fact.id,'prior_unit_execution') ON CONFLICT DO NOTHING;
        END LOOP;
        RETURN NEW;
      END $$;
      CREATE TRIGGER procurement_reallocation_identity_conflict AFTER INSERT ON procurement_operation_units
        FOR EACH ROW EXECUTE FUNCTION record_reallocation_after_identity_conflict();
      -- Extend the existing append-only ledger semantics without rewriting its
      -- historical migration or mutating previous facts.
      DO $patch$
      DECLARE source text; changed text;
      BEGIN
        SELECT pg_get_functiondef('procurement_risk_apply_event()'::regprocedure) INTO source;
        changed := replace(source, $old$''success'', ''debit_confirmed''$old$,
          $new$''success'', ''debit_confirmed'', ''identity_conflict''$new$);
        IF changed=source THEN RAISE EXCEPTION 'Unable to extend risk evidence guard'; END IF;
        EXECUTE changed;
        SELECT pg_get_functiondef('procurement_risk_reinstate_from_evidence(uuid)'::regprocedure) INTO source;
        changed := replace(source, $old$'success', 'debit_confirmed'$old$,
          $new$'success', 'debit_confirmed', 'identity_conflict'$new$);
        IF changed=source THEN RAISE EXCEPTION 'Unable to extend risk reinstatement'; END IF;
        EXECUTE changed;
        SELECT pg_get_functiondef('procurement_evidence_restore_risk()'::regprocedure) INTO source;
        changed := replace(source, $old$'success','debit_confirmed'$old$,
          $new$'success','debit_confirmed','identity_conflict'$new$);
        IF changed=source THEN RAISE EXCEPTION 'Unable to extend evidence risk restoration'; END IF;
        EXECUTE changed;
        IF EXISTS (SELECT 1 FROM procurement_risk_events release
          WHERE release.kind='release' AND procurement_has_identity_conflict(release.operation_id)
            AND NOT EXISTS (SELECT 1 FROM procurement_risk_events restored
              WHERE restored.operation_id=release.operation_id AND restored.kind='reinstate')) THEN
          RAISE EXCEPTION 'Unreconciled historical identity conflict requires risk review before migration'
            USING ERRCODE='55000';
        END IF;
      END $patch$;
      CREATE FUNCTION guard_identity_conflict_risk_release() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE parent_id uuid;
      BEGIN
        IF NEW.kind='release' THEN
          SELECT source.order_id INTO parent_id FROM procurement_operations operation
            JOIN order_item_procurement_sources source ON source.id=operation.source_id WHERE operation.id=NEW.operation_id;
          PERFORM id FROM orders WHERE id=parent_id FOR UPDATE NOWAIT;
          IF procurement_has_identity_conflict(NEW.operation_id) THEN
            RAISE EXCEPTION 'Supplier identity conflict prevents risk release'
              USING ERRCODE='23514', CONSTRAINT='procurement_identity_conflict_unresolved';
          END IF;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER procurement_identity_conflict_risk_release_guard BEFORE INSERT ON procurement_risk_events
        FOR EACH ROW EXECUTE FUNCTION guard_identity_conflict_risk_release();
      CREATE FUNCTION guard_procurement_identity_conflict_operation() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE parent_id uuid;
      BEGIN
        IF NEW.state IS DISTINCT FROM OLD.state AND NEW.state IN ('submit_in_flight','rejected','completed') THEN
          SELECT order_id INTO parent_id FROM order_item_procurement_sources WHERE id=NEW.source_id;
          -- Direct SQL acquires the operation row first. Never wait for the
          -- order here: normal execution takes the order before the operation.
          PERFORM id FROM orders WHERE id=parent_id FOR UPDATE NOWAIT;
          IF procurement_has_identity_conflict(NEW.id) THEN
            RAISE EXCEPTION 'Supplier identity conflict requires manual review'
              USING ERRCODE='23514', CONSTRAINT='procurement_identity_conflict_unresolved';
          END IF;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER procurement_identity_conflict_operation_guard BEFORE UPDATE ON procurement_operations
        FOR EACH ROW EXECUTE FUNCTION guard_procurement_identity_conflict_operation();
      CREATE FUNCTION guard_procurement_identity_conflict_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE parent_id uuid;
      BEGIN
        IF NEW.delivery_source='procurement' THEN
          SELECT order_id INTO parent_id FROM order_items WHERE id=NEW.order_item_id;
          PERFORM id FROM orders WHERE id=parent_id FOR UPDATE NOWAIT;
          IF procurement_has_identity_conflict(NEW.procurement_operation_id) THEN
            RAISE EXCEPTION 'Supplier identity conflict blocks procurement fulfillment'
              USING ERRCODE='23514', CONSTRAINT='procurement_identity_conflict_unresolved';
          END IF;
        ELSIF TG_OP='INSERT' THEN
          SELECT order_id INTO parent_id FROM order_items WHERE id=NEW.order_item_id;
          PERFORM id FROM orders WHERE id=parent_id FOR UPDATE NOWAIT;
          IF EXISTS (SELECT 1 FROM procurement_operation_units unit
            WHERE unit.order_item_id=NEW.order_item_id AND unit.state='rejected'
              AND procurement_has_identity_conflict(unit.operation_id)) THEN
            RAISE EXCEPTION 'Earlier supplier identity conflict blocks competing fulfillment'
              USING ERRCODE='23514', CONSTRAINT='procurement_fulfillment_conflict';
          END IF;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER procurement_identity_conflict_attempt_guard BEFORE INSERT OR UPDATE ON order_item_fulfillment_attempts
        FOR EACH ROW EXECUTE FUNCTION guard_procurement_identity_conflict_attempt();
      CREATE FUNCTION guard_procurement_identity_conflict_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE operation_uuid uuid; parent_id uuid;
      BEGIN
        IF NEW.delivery_source='procurement' THEN
          SELECT attempt.procurement_operation_id, item.order_id INTO operation_uuid, parent_id
          FROM order_item_fulfillment_attempts attempt JOIN order_items item ON item.id=attempt.order_item_id
          WHERE attempt.id=NEW.fulfillment_attempt_id;
          PERFORM id FROM orders WHERE id=parent_id FOR UPDATE NOWAIT;
          IF procurement_has_identity_conflict(operation_uuid) THEN
            RAISE EXCEPTION 'Supplier identity conflict blocks procurement delivery'
              USING ERRCODE='23514', CONSTRAINT='procurement_identity_conflict_unresolved';
          END IF;
        ELSE
          SELECT item.order_id INTO parent_id FROM order_item_fulfillment_attempts attempt
            JOIN order_items item ON item.id=attempt.order_item_id WHERE attempt.id=NEW.fulfillment_attempt_id;
          PERFORM id FROM orders WHERE id=parent_id FOR UPDATE NOWAIT;
          IF EXISTS (SELECT 1 FROM order_item_fulfillment_attempts attempt
            JOIN procurement_operation_units unit ON unit.order_item_id=attempt.order_item_id AND unit.unit_index=NEW.unit_index
            WHERE attempt.id=NEW.fulfillment_attempt_id AND unit.state='rejected'
              AND procurement_has_identity_conflict(unit.operation_id)) THEN
            RAISE EXCEPTION 'Earlier supplier identity conflict blocks competing delivery'
              USING ERRCODE='23514', CONSTRAINT='procurement_delivery_conflict';
          END IF;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER procurement_identity_conflict_delivery_guard BEFORE INSERT ON order_item_fulfillment_deliveries
        FOR EACH ROW EXECUTE FUNCTION guard_procurement_identity_conflict_delivery();
    `.execute(db)
  },
  async down() {
    throw new Error('Procurement execution evidence and delivery identities are permanent; this migration is forward-only.')
  },
}
