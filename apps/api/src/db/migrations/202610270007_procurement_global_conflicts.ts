import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

/** Keep cross-operation supplier identity conflicts as immutable, global risk. */
export const procurementGlobalConflictsMigration: Migration = {
  async up(db) {
    await sql`
      CREATE FUNCTION procurement_has_unresolved_conflict(operation_uuid uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
        SELECT EXISTS (SELECT 1 FROM procurement_execution_evidence e
          WHERE e.operation_id=operation_uuid AND e.kind='identity_conflict')
          OR (SELECT count(DISTINCT e.supplier_order_number)>1 FROM procurement_execution_evidence e
            WHERE e.operation_id=operation_uuid AND e.supplier_order_number IS NOT NULL)
          OR EXISTS (SELECT 1 FROM procurement_execution_conflicts c WHERE c.operation_id=operation_uuid)
          OR EXISTS (SELECT 1 FROM procurement_operation_units mine
            JOIN procurement_operation_units other ON other.order_item_id=mine.order_item_id
              AND other.unit_index=mine.unit_index AND other.operation_id<>mine.operation_id
            JOIN procurement_execution_evidence e ON e.operation_id=other.operation_id
            WHERE mine.operation_id=operation_uuid AND (e.kind IN ('identity_conflict','debit_confirmed')
              OR (e.kind='success' AND mine.unit_index=ANY(e.unit_indices))))
          OR EXISTS (SELECT 1 FROM procurement_execution_evidence mine
            JOIN procurement_operations o ON o.id=mine.operation_id
            JOIN order_item_procurement_sources s ON s.id=o.source_id
            JOIN order_item_procurement_sources os ON os.supplier_connection_id=s.supplier_connection_id
            JOIN procurement_operations other ON other.source_id=os.id AND other.id<>o.id
            JOIN procurement_execution_evidence theirs ON theirs.operation_id=other.id
              AND theirs.supplier_order_number=mine.supplier_order_number
            WHERE o.id=operation_uuid AND mine.supplier_order_number IS NOT NULL)
      $$;
      CREATE OR REPLACE FUNCTION procurement_has_identity_conflict(operation_uuid uuid) RETURNS boolean
      LANGUAGE sql VOLATILE AS $$ SELECT procurement_has_unresolved_conflict(operation_uuid) $$;
      CREATE FUNCTION procurement_lock_order_risk(order_uuid uuid) RETURNS void LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM order_item_procurement_sources WHERE order_id=order_uuid) THEN RETURN; END IF;
        PERFORM id FROM orders WHERE id=order_uuid FOR UPDATE NOWAIT;
        PERFORM p.currency FROM procurement_risk_policies p WHERE p.currency IN (
          SELECT r.currency FROM procurement_risk_reservations r JOIN procurement_operations o ON o.id=r.operation_id
          JOIN order_items i ON i.id=o.order_item_id WHERE i.order_id=order_uuid)
          ORDER BY p.currency FOR UPDATE;
      END $$;
      CREATE OR REPLACE FUNCTION order_has_unresolved_fulfillment(order_uuid uuid) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
      DECLARE unresolved boolean;
      BEGIN
        PERFORM procurement_lock_order_risk(order_uuid);
        SELECT EXISTS (SELECT 1 FROM order_items i WHERE i.order_id=order_uuid AND
          (i.fulfillment_reserved_quantity>0 OR EXISTS (SELECT 1 FROM order_item_fulfillment_attempts a
            WHERE a.order_item_id=i.id AND a.status IN ('processing','unknown'))))
          OR EXISTS (SELECT 1 FROM procurement_operations o JOIN order_items i ON i.id=o.order_item_id
            WHERE i.order_id=order_uuid AND (o.state NOT IN ('rejected','completed')
              OR procurement_has_unresolved_conflict(o.id)
              OR (o.state='rejected' AND EXISTS (SELECT 1 FROM procurement_execution_evidence e
                WHERE e.operation_id=o.id AND e.kind IN ('success','debit_confirmed'))))) INTO unresolved;
        RETURN unresolved;
      END $$;
      CREATE OR REPLACE FUNCTION procurement_unit_has_prior_execution(operation_uuid uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
        SELECT EXISTS (SELECT 1 FROM procurement_operation_units mine
          JOIN procurement_operation_units other ON other.order_item_id=mine.order_item_id
            AND other.unit_index=mine.unit_index AND other.operation_id<>mine.operation_id
          WHERE mine.operation_id=operation_uuid AND (
            EXISTS (SELECT 1 FROM procurement_execution_conflicts c WHERE c.operation_id=other.operation_id)
            OR EXISTS (SELECT 1 FROM procurement_execution_evidence e WHERE e.operation_id=other.operation_id
              AND (e.kind IN ('debit_confirmed','identity_conflict') OR (e.kind='success' AND mine.unit_index=ANY(e.unit_indices))))))
      $$;
      DROP INDEX procurement_risk_evidence_once;
      CREATE UNIQUE INDEX procurement_risk_evidence_once ON procurement_risk_events(operation_id,evidence_id,kind)
        WHERE evidence_id IS NOT NULL;
      DO $patch$
      DECLARE source text; changed text;
      BEGIN
        SELECT pg_get_functiondef('procurement_risk_apply_event()'::regprocedure) INTO source;
        changed := replace(source, $old$          IF NOT evidence_matches THEN
            RAISE EXCEPTION 'Risk settlement requires matching execution evidence'$old$,
          $new$          IF NOT evidence_matches AND NEW.kind = 'reinstate' AND pg_trigger_depth() >= 2 THEN
            SELECT EXISTS (SELECT 1 FROM procurement_execution_conflicts c
              WHERE c.operation_id=NEW.operation_id AND c.evidence_id=NEW.evidence_id AND c.reason='supplier_number') INTO evidence_matches;
          END IF;
          IF NOT evidence_matches THEN
            RAISE EXCEPTION 'Risk settlement requires matching execution evidence'$new$);
        IF changed=source THEN RAISE EXCEPTION 'Unable to extend collision risk evidence'; END IF;
        EXECUTE changed;
        IF EXISTS (SELECT 1 FROM procurement_risk_events r WHERE r.kind='release'
          AND procurement_has_unresolved_conflict(r.operation_id)
          AND NOT EXISTS (SELECT 1 FROM procurement_risk_events x WHERE x.operation_id=r.operation_id AND x.kind='reinstate')) THEN
          RAISE EXCEPTION 'Unreconciled historical procurement collision requires review' USING ERRCODE='55000';
        END IF;
      END $patch$;
      CREATE FUNCTION procurement_restore_collision_risk() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE r procurement_risk_reservations%ROWTYPE;
      BEGIN
        IF NEW.reason<>'supplier_number' THEN RETURN NEW; END IF;
        SELECT * INTO r FROM procurement_risk_reservations WHERE operation_id=NEW.operation_id;
        IF r.operation_id IS NULL THEN RETURN NEW; END IF;
        PERFORM 1 FROM procurement_risk_policies WHERE currency=r.currency FOR UPDATE NOWAIT;
        IF EXISTS (SELECT 1 FROM procurement_risk_events WHERE operation_id=NEW.operation_id AND kind='release')
          AND NOT EXISTS (SELECT 1 FROM procurement_risk_events WHERE operation_id=NEW.operation_id AND kind='reinstate') THEN
          INSERT INTO procurement_risk_events(id,operation_id,currency,kind,amount_minor,evidence_id)
            VALUES (gen_random_uuid(),NEW.operation_id,r.currency,'reinstate',r.amount_minor,NEW.evidence_id);
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER procurement_conflict_restore_risk AFTER INSERT ON procurement_execution_conflicts
        FOR EACH ROW EXECUTE FUNCTION procurement_restore_collision_risk();
      CREATE FUNCTION guard_procurement_global_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE parent_id uuid; item_id uuid; conn uuid; currency_code text;
      BEGIN
        SELECT s.order_id,o.order_item_id,s.supplier_connection_id,r.currency
          INTO parent_id,item_id,conn,currency_code FROM procurement_operations o
          JOIN order_item_procurement_sources s ON s.id=o.source_id
          LEFT JOIN procurement_risk_reservations r ON r.operation_id=o.id WHERE o.id=NEW.operation_id;
        PERFORM id FROM orders WHERE id=parent_id FOR UPDATE NOWAIT;
        PERFORM id FROM order_items WHERE id=item_id FOR UPDATE NOWAIT;
        IF currency_code IS NULL THEN
          RAISE EXCEPTION 'Supplier evidence requires a reserved risk identity' USING ERRCODE='23514', CONSTRAINT='procurement_global_conflict';
        END IF;
        PERFORM 1 FROM procurement_risk_policies WHERE currency=currency_code FOR UPDATE NOWAIT;
        IF NEW.supplier_order_number IS NOT NULL AND NOT pg_try_advisory_xact_lock(hashtextextended(
          'procurement-number:' || conn::text || ':' || NEW.supplier_order_number,0)) THEN
          RAISE EXCEPTION 'Supplier identity is busy' USING ERRCODE='55P03';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER procurement_aa_global_evidence_guard BEFORE INSERT ON procurement_execution_evidence
        FOR EACH ROW EXECUTE FUNCTION guard_procurement_global_evidence();
      CREATE FUNCTION guard_procurement_global_intent() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE parent_id uuid; conn uuid; number text; currency_code text;
      BEGIN
        SELECT s.order_id,s.supplier_connection_id,o.supplier_order_number,r.currency
          INTO parent_id,conn,number,currency_code FROM procurement_operations o
          JOIN order_item_procurement_sources s ON s.id=o.source_id
          LEFT JOIN procurement_risk_reservations r ON r.operation_id=o.id WHERE o.id=NEW.operation_id;
        PERFORM id FROM orders WHERE id=parent_id FOR UPDATE NOWAIT;
        PERFORM id FROM order_items WHERE id=(SELECT order_item_id FROM procurement_operations WHERE id=NEW.operation_id) FOR UPDATE NOWAIT;
        IF currency_code IS NULL THEN
          RAISE EXCEPTION 'Supplier request requires reserved risk' USING ERRCODE='23514', CONSTRAINT='procurement_global_conflict';
        END IF;
        PERFORM 1 FROM procurement_risk_policies WHERE currency=currency_code FOR UPDATE NOWAIT;
        IF number IS NOT NULL AND NOT pg_try_advisory_xact_lock(hashtextextended('procurement-number:' || conn::text || ':' || number,0)) THEN
          RAISE EXCEPTION 'Supplier identity is busy' USING ERRCODE='55P03';
        END IF;
        IF procurement_has_unresolved_conflict(NEW.operation_id) THEN
          RAISE EXCEPTION 'Supplier conflict prevents an automatic request' USING ERRCODE='23514', CONSTRAINT='procurement_global_conflict';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER procurement_global_intent_guard BEFORE INSERT ON procurement_request_intents
        FOR EACH ROW EXECUTE FUNCTION guard_procurement_global_intent();
      CREATE FUNCTION guard_procurement_global_operation() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE parent_id uuid;
      BEGIN
        IF NEW.state IS DISTINCT FROM OLD.state AND NEW.state IN ('submit_in_flight','accepted_pending','success_pending_finalize','rejected','completed') THEN
          SELECT order_id INTO parent_id FROM order_item_procurement_sources WHERE id=NEW.source_id;
          PERFORM id FROM orders WHERE id=parent_id FOR UPDATE NOWAIT;
          PERFORM p.currency FROM procurement_risk_policies p JOIN procurement_risk_reservations r ON r.currency=p.currency
            WHERE r.operation_id=NEW.id FOR UPDATE OF p NOWAIT;
          IF procurement_has_unresolved_conflict(NEW.id) THEN
            RAISE EXCEPTION 'Supplier conflict requires review' USING ERRCODE='23514', CONSTRAINT='procurement_global_conflict';
          END IF;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER procurement_zz_global_operation_guard BEFORE UPDATE ON procurement_operations
        FOR EACH ROW EXECUTE FUNCTION guard_procurement_global_operation();
      CREATE FUNCTION guard_procurement_global_fulfillment() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE item_uuid uuid; parent_id uuid; operation_uuid uuid;
      BEGIN
        IF TG_TABLE_NAME='order_item_fulfillment_attempts' THEN
          item_uuid:=NEW.order_item_id; operation_uuid:=NEW.procurement_operation_id;
        ELSE
          SELECT a.order_item_id,a.procurement_operation_id INTO item_uuid,operation_uuid
            FROM order_item_fulfillment_attempts a WHERE a.id=NEW.fulfillment_attempt_id;
        END IF;
        SELECT order_id INTO parent_id FROM order_items WHERE id=item_uuid;
        PERFORM procurement_lock_order_risk(parent_id);
        IF operation_uuid IS NOT NULL AND procurement_has_unresolved_conflict(operation_uuid) THEN
          RAISE EXCEPTION 'Supplier conflict blocks procurement fulfillment' USING ERRCODE='23514', CONSTRAINT='procurement_global_conflict';
        END IF;
        IF operation_uuid IS NULL AND EXISTS (SELECT 1 FROM procurement_operations o
          WHERE o.order_item_id=item_uuid AND procurement_has_unresolved_conflict(o.id)) THEN
          RAISE EXCEPTION 'Supplier conflict blocks competing fulfillment' USING ERRCODE='23514', CONSTRAINT='procurement_fulfillment_conflict';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER procurement_zz_global_attempt_guard BEFORE INSERT OR UPDATE ON order_item_fulfillment_attempts
        FOR EACH ROW EXECUTE FUNCTION guard_procurement_global_fulfillment();
      CREATE TRIGGER procurement_zz_global_delivery_guard BEFORE INSERT ON order_item_fulfillment_deliveries
        FOR EACH ROW EXECUTE FUNCTION guard_procurement_global_fulfillment();
    `.execute(db)
  },
  async down() { throw new Error('Procurement execution evidence and delivery identities are permanent; this migration is forward-only.') },
}
