import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

/** A synthetic-only risk ledger. These rows are not a procurement enablement switch. */
export const procurementRiskBudgetMigration: Migration = {
  async up(db) {
    await sql`
      CREATE TABLE procurement_risk_policies (
        currency varchar(3) PRIMARY KEY CHECK (currency = 'TST'),
        per_operation_minor numeric(20,0) NOT NULL CHECK (per_operation_minor > 0),
        global_daily_minor numeric(20,0) NOT NULL CHECK (global_daily_minor >= 0),
        global_outstanding_minor numeric(20,0) NOT NULL CHECK (global_outstanding_minor >= 0),
        supplier_daily_minor numeric(20,0) NOT NULL CHECK (supplier_daily_minor >= 0),
        supplier_outstanding_minor numeric(20,0) NOT NULL CHECK (supplier_outstanding_minor >= 0),
        sku_daily_minor numeric(20,0) NOT NULL CHECK (sku_daily_minor >= 0),
        sku_outstanding_minor numeric(20,0) NOT NULL CHECK (sku_outstanding_minor >= 0),
        paused boolean NOT NULL DEFAULT false
      )
    `.execute(db)
    await sql`
      CREATE TABLE procurement_risk_buckets (
        currency varchar(3) NOT NULL REFERENCES procurement_risk_policies(currency) ON DELETE RESTRICT,
        scope_kind varchar(12) NOT NULL CHECK (scope_kind IN ('global', 'supplier', 'sku')),
        scope_key text NOT NULL,
        outstanding_minor numeric(20,0) NOT NULL DEFAULT 0 CHECK (outstanding_minor >= 0),
        PRIMARY KEY (currency, scope_kind, scope_key)
      )
    `.execute(db)
    await sql`
      CREATE TABLE procurement_risk_daily (
        currency varchar(3) NOT NULL,
        scope_kind varchar(12) NOT NULL,
        scope_key text NOT NULL,
        utc_day date NOT NULL,
        gross_minor numeric(20,0) NOT NULL DEFAULT 0 CHECK (gross_minor >= 0),
        PRIMARY KEY (currency, scope_kind, scope_key, utc_day),
        FOREIGN KEY (currency, scope_kind, scope_key)
          REFERENCES procurement_risk_buckets(currency, scope_kind, scope_key) ON DELETE RESTRICT
      )
    `.execute(db)
    await sql`
      CREATE TABLE procurement_risk_reservations (
        operation_id uuid PRIMARY KEY REFERENCES procurement_operations(id) ON DELETE RESTRICT,
        supplier_connection_id uuid NOT NULL REFERENCES supplier_connections(id) ON DELETE RESTRICT,
        product_variant_id uuid NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
        currency varchar(3) NOT NULL REFERENCES procurement_risk_policies(currency) ON DELETE RESTRICT,
        amount_minor numeric(20,0) NOT NULL CHECK (amount_minor > 0),
        utc_day date NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `.execute(db)
    await sql`
      CREATE TABLE procurement_risk_events (
        id uuid PRIMARY KEY,
        operation_id uuid NOT NULL REFERENCES procurement_risk_reservations(operation_id) ON DELETE RESTRICT,
        currency varchar(3) NOT NULL REFERENCES procurement_risk_policies(currency) ON DELETE RESTRICT,
        kind varchar(12) NOT NULL CHECK (kind IN ('reserve', 'debit', 'release', 'reinstate', 'partial', 'review')),
        amount_minor numeric(20,0) NOT NULL,
        evidence_id uuid,
        operation_revision integer,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        FOREIGN KEY (operation_id, operation_revision) REFERENCES procurement_operation_events(operation_id, revision) ON DELETE RESTRICT,
        CHECK ((kind IN ('partial', 'review') AND amount_minor = 0) OR
          (kind IN ('reserve', 'debit', 'release', 'reinstate') AND amount_minor > 0)),
        CHECK ((kind = 'reserve' AND evidence_id IS NULL AND operation_revision IS NULL)
          OR (kind = 'review' AND evidence_id IS NULL AND operation_revision IS NOT NULL)
          OR (kind IN ('debit', 'release', 'reinstate', 'partial') AND evidence_id IS NOT NULL AND operation_revision IS NULL))
      )
    `.execute(db)
    await sql`CREATE UNIQUE INDEX procurement_risk_one_reserve ON procurement_risk_events(operation_id) WHERE kind = 'reserve'`.execute(db)
    await sql`CREATE UNIQUE INDEX procurement_risk_evidence_once ON procurement_risk_events(evidence_id, kind) WHERE evidence_id IS NOT NULL`.execute(db)
    await sql`CREATE UNIQUE INDEX procurement_risk_reinstate_once ON procurement_risk_events(operation_id) WHERE kind = 'reinstate'`.execute(db)
    await sql`CREATE UNIQUE INDEX procurement_risk_review_once ON procurement_risk_events(operation_id, operation_revision) WHERE kind = 'review'`.execute(db)
    await sql`
      CREATE FUNCTION procurement_risk_policy_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' OR ROW(NEW.currency, NEW.per_operation_minor, NEW.global_daily_minor,
          NEW.global_outstanding_minor, NEW.supplier_daily_minor, NEW.supplier_outstanding_minor,
          NEW.sku_daily_minor, NEW.sku_outstanding_minor) IS DISTINCT FROM
          ROW(OLD.currency, OLD.per_operation_minor, OLD.global_daily_minor, OLD.global_outstanding_minor,
          OLD.supplier_daily_minor, OLD.supplier_outstanding_minor, OLD.sku_daily_minor, OLD.sku_outstanding_minor) THEN
          RAISE EXCEPTION 'Synthetic risk limits are immutable' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $$
    `.execute(db)
    await sql`CREATE TRIGGER procurement_risk_policy_guard BEFORE UPDATE OR DELETE ON procurement_risk_policies FOR EACH ROW EXECUTE FUNCTION procurement_risk_policy_guard()`.execute(db)
    await sql`
      CREATE FUNCTION procurement_risk_counter_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' OR pg_trigger_depth() < 2 THEN
          RAISE EXCEPTION 'Risk counters are maintained only by ledger triggers' USING ERRCODE = '23514';
        END IF;
        IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'procurement_risk_daily' THEN
          IF NEW.gross_minor < OLD.gross_minor THEN
            RAISE EXCEPTION 'Daily gross risk cannot decrease' USING ERRCODE = '23514';
          END IF;
        END IF;
        RETURN NEW;
      END $$
    `.execute(db)
    for (const table of ['procurement_risk_buckets', 'procurement_risk_daily']) {
      await sql.raw(`CREATE TRIGGER ${table}_guard BEFORE INSERT OR UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION procurement_risk_counter_guard()`).execute(db)
      await sql.raw(`CREATE TRIGGER ${table}_no_truncate BEFORE TRUNCATE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION protect_order_purchase_immutable()`).execute(db)
    }
    await sql`
      CREATE FUNCTION procurement_risk_apply_event() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE r procurement_risk_reservations%ROWTYPE; existing numeric; bucket record; evidence_matches boolean;
      BEGIN
        SELECT * INTO r FROM procurement_risk_reservations WHERE operation_id = NEW.operation_id;
        IF r.operation_id IS NULL OR NEW.currency <> r.currency THEN
          RAISE EXCEPTION 'Risk event identity mismatch' USING ERRCODE = '23514';
        END IF;
        -- This row lock serializes policies, pause, reservations, and ledger updates across instances.
        PERFORM 1 FROM procurement_risk_policies WHERE currency = r.currency FOR UPDATE NOWAIT;
        IF NEW.kind = 'reserve' THEN
          IF pg_trigger_depth() < 2 OR NEW.amount_minor <> r.amount_minor THEN
            RAISE EXCEPTION 'Reservation facts must originate with reservation' USING ERRCODE = '23514';
          END IF;
        ELSIF NEW.kind = 'review' THEN
          IF pg_trigger_depth() < 2 OR NOT EXISTS (SELECT 1 FROM procurement_operation_events
            WHERE operation_id = NEW.operation_id AND revision = NEW.operation_revision
              AND next_state = 'manual_review' AND previous_state IS DISTINCT FROM next_state) THEN
            RAISE EXCEPTION 'Review risk fact requires its operation transition' USING ERRCODE = '23514';
          END IF;
          RETURN NEW;
        ELSIF NEW.kind = 'partial' THEN
          IF pg_trigger_depth() < 2 OR to_regclass('procurement_execution_evidence') IS NULL THEN
            RAISE EXCEPTION 'Partial risk fact requires execution evidence' USING ERRCODE = '23514';
          END IF;
          EXECUTE 'SELECT EXISTS (SELECT 1 FROM procurement_execution_evidence e WHERE e.id = $1
            AND e.operation_id = $2 AND e.kind = ''success'' AND cardinality(e.unit_indices) > 0
            AND cardinality(e.unit_indices) < (SELECT count(*) FROM procurement_operation_units WHERE operation_id = $2))'
            INTO evidence_matches USING NEW.evidence_id, NEW.operation_id;
          IF NOT evidence_matches THEN
            RAISE EXCEPTION 'Partial risk fact requires partial success evidence' USING ERRCODE = '23514';
          END IF;
          RETURN NEW;
        ELSE
          IF to_regclass('procurement_execution_evidence') IS NULL THEN
            RAISE EXCEPTION 'Execution evidence is unavailable' USING ERRCODE = '23514';
          END IF;
          EXECUTE 'SELECT EXISTS (SELECT 1 FROM procurement_execution_evidence WHERE id = $1
            AND operation_id = $2 AND (($3 = ''release'' AND kind = ''rejected'' AND amount_minor = $4 AND currency = $5
                AND NOT EXISTS (SELECT 1 FROM procurement_execution_evidence other WHERE other.operation_id = $2
                  AND other.kind IN (''success'', ''debit_confirmed'')))
              OR ($3 = ''debit'' AND kind = ''debit_confirmed'' AND amount_minor = $4 AND currency = $5)
              OR ($3 = ''reinstate'' AND kind IN (''success'', ''debit_confirmed''))))'
            INTO evidence_matches USING NEW.evidence_id, NEW.operation_id, NEW.kind, NEW.amount_minor, NEW.currency;
          IF NOT evidence_matches THEN
            RAISE EXCEPTION 'Risk settlement requires matching execution evidence' USING ERRCODE = '23514';
          END IF;
          SELECT COALESCE(sum(CASE WHEN kind = 'reinstate' THEN -amount_minor ELSE amount_minor END), 0)
            INTO existing FROM procurement_risk_events
            WHERE operation_id = NEW.operation_id AND kind IN ('debit', 'release', 'reinstate');
          IF NEW.kind = 'release' AND (existing <> 0 OR NEW.amount_minor <> r.amount_minor) THEN
            RAISE EXCEPTION 'Partial risk release lacks proven allocation' USING ERRCODE = '23514';
          END IF;
          IF NEW.kind = 'reinstate' AND (existing <> r.amount_minor OR NEW.amount_minor <> r.amount_minor
            OR NOT EXISTS (SELECT 1 FROM procurement_risk_events WHERE operation_id = NEW.operation_id AND kind = 'release')) THEN
            RAISE EXCEPTION 'Risk reinstatement requires prior full release' USING ERRCODE = '23514';
          END IF;
          IF NEW.kind <> 'reinstate' AND existing + NEW.amount_minor > r.amount_minor THEN
            RAISE EXCEPTION 'Risk fact exceeds reserved exposure' USING ERRCODE = '23514';
          END IF;
        END IF;
        FOR bucket IN SELECT * FROM (VALUES ('global', '*'), ('supplier', r.supplier_connection_id::text),
          ('sku', r.product_variant_id::text)) AS b(kind, key)
        LOOP
          UPDATE procurement_risk_buckets SET outstanding_minor = outstanding_minor +
            CASE WHEN NEW.kind IN ('reserve', 'reinstate') THEN NEW.amount_minor ELSE -NEW.amount_minor END
            WHERE currency = r.currency AND scope_kind = bucket.kind AND scope_key = bucket.key;
          IF NOT FOUND THEN RAISE EXCEPTION 'Missing risk bucket' USING ERRCODE = '23514'; END IF;
        END LOOP;
        RETURN NEW;
      END $$
    `.execute(db)
    await sql`CREATE TRIGGER procurement_risk_event_apply BEFORE INSERT ON procurement_risk_events FOR EACH ROW EXECUTE FUNCTION procurement_risk_apply_event()`.execute(db)
    await sql`
      CREATE FUNCTION procurement_risk_reinstate_from_evidence(evidence_uuid uuid) RETURNS void LANGUAGE plpgsql AS $$
      DECLARE operation_uuid uuid; evidence_kind text; r procurement_risk_reservations%ROWTYPE;
      BEGIN
        EXECUTE 'SELECT operation_id, kind FROM procurement_execution_evidence WHERE id = $1'
          INTO operation_uuid, evidence_kind USING evidence_uuid;
        IF evidence_kind NOT IN ('success', 'debit_confirmed') THEN RETURN; END IF;
        SELECT * INTO r FROM procurement_risk_reservations WHERE operation_id = operation_uuid;
        IF r.operation_id IS NULL THEN RETURN; END IF;
        PERFORM 1 FROM procurement_risk_policies WHERE currency = r.currency FOR UPDATE NOWAIT;
        IF EXISTS (SELECT 1 FROM procurement_risk_events WHERE operation_id = operation_uuid AND kind = 'release')
          AND NOT EXISTS (SELECT 1 FROM procurement_risk_events WHERE operation_id = operation_uuid AND kind = 'reinstate') THEN
          INSERT INTO procurement_risk_events(id, operation_id, currency, kind, amount_minor, evidence_id)
            VALUES (gen_random_uuid(), operation_uuid, r.currency, 'reinstate', r.amount_minor, evidence_uuid);
        END IF;
      END $$
    `.execute(db)
    await sql`
      CREATE FUNCTION procurement_risk_note_from_evidence(evidence_uuid uuid) RETURNS void LANGUAGE plpgsql AS $$
      DECLARE operation_uuid uuid; is_partial boolean; risk_currency text;
      BEGIN
        EXECUTE 'SELECT operation_id, kind = ''success'' AND cardinality(unit_indices) > 0
          AND cardinality(unit_indices) < (SELECT count(*) FROM procurement_operation_units WHERE operation_id = e.operation_id)
          FROM procurement_execution_evidence e WHERE id = $1'
          INTO operation_uuid, is_partial USING evidence_uuid;
        IF is_partial IS DISTINCT FROM true THEN RETURN; END IF;
        SELECT currency INTO risk_currency FROM procurement_risk_reservations WHERE operation_id = operation_uuid;
        IF risk_currency IS NULL THEN RETURN; END IF;
        INSERT INTO procurement_risk_events(id, operation_id, currency, kind, amount_minor, evidence_id)
          VALUES (gen_random_uuid(), operation_uuid, risk_currency, 'partial', 0, evidence_uuid)
          ON CONFLICT DO NOTHING;
      END $$
    `.execute(db)
    await sql`
      CREATE FUNCTION procurement_risk_note_from_review(operation_uuid uuid, event_revision integer) RETURNS void LANGUAGE plpgsql AS $$
      DECLARE risk_currency text;
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM procurement_operation_events WHERE operation_id = operation_uuid
          AND revision = event_revision AND next_state = 'manual_review' AND previous_state IS DISTINCT FROM next_state) THEN RETURN; END IF;
        SELECT currency INTO risk_currency FROM procurement_risk_reservations WHERE operation_id = operation_uuid;
        IF risk_currency IS NULL THEN RETURN; END IF;
        INSERT INTO procurement_risk_events(id, operation_id, currency, kind, amount_minor, operation_revision)
          VALUES (gen_random_uuid(), operation_uuid, risk_currency, 'review', 0, event_revision)
          ON CONFLICT DO NOTHING;
      END $$
    `.execute(db)
    await sql`
      CREATE FUNCTION procurement_risk_reserve() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE p procurement_risk_policies%ROWTYPE; identity_row record; b record; current_out numeric; current_day numeric;
      BEGIN
        SELECT source.supplier_connection_id, source.product_variant_id, op.state, op.allocations_sealed
          INTO identity_row FROM procurement_operations op JOIN order_item_procurement_sources source ON source.id = op.source_id
          WHERE op.id = NEW.operation_id;
        IF identity_row.supplier_connection_id IS DISTINCT FROM NEW.supplier_connection_id
          OR identity_row.product_variant_id IS DISTINCT FROM NEW.product_variant_id
          OR identity_row.state <> 'prepared' OR NOT identity_row.allocations_sealed
          OR NOT EXISTS (SELECT 1 FROM procurement_operation_events e WHERE e.operation_id = NEW.operation_id
            AND e.revision = 0 AND e.xmin = pg_current_xact_id()::text::xid) THEN
          RAISE EXCEPTION 'Risk reservation must accompany new prepared identity' USING ERRCODE = '23514';
        END IF;
        SELECT * INTO p FROM procurement_risk_policies WHERE currency = NEW.currency FOR UPDATE;
        IF p.currency IS NULL OR p.paused OR NEW.amount_minor > p.per_operation_minor THEN
          RAISE EXCEPTION 'Risk policy unavailable, paused, or single limit exceeded' USING ERRCODE = '23514';
        END IF;
        FOR b IN SELECT * FROM (VALUES ('global', '*', p.global_daily_minor, p.global_outstanding_minor),
          ('supplier', NEW.supplier_connection_id::text, p.supplier_daily_minor, p.supplier_outstanding_minor),
          ('sku', NEW.product_variant_id::text, p.sku_daily_minor, p.sku_outstanding_minor)) AS x(kind, key, daily_limit, outstanding_limit)
        LOOP
          INSERT INTO procurement_risk_buckets(currency, scope_kind, scope_key) VALUES (NEW.currency, b.kind, b.key) ON CONFLICT DO NOTHING;
          SELECT outstanding_minor INTO current_out FROM procurement_risk_buckets
            WHERE currency = NEW.currency AND scope_kind = b.kind AND scope_key = b.key FOR UPDATE;
          INSERT INTO procurement_risk_daily(currency, scope_kind, scope_key, utc_day)
            VALUES (NEW.currency, b.kind, b.key, NEW.utc_day) ON CONFLICT DO NOTHING;
          SELECT gross_minor INTO current_day FROM procurement_risk_daily
            WHERE currency = NEW.currency AND scope_kind = b.kind AND scope_key = b.key AND utc_day = NEW.utc_day FOR UPDATE;
          IF current_out + NEW.amount_minor > b.outstanding_limit OR current_day + NEW.amount_minor > b.daily_limit THEN
            RAISE EXCEPTION 'Risk budget exceeded' USING ERRCODE = '23514';
          END IF;
          UPDATE procurement_risk_daily SET gross_minor = gross_minor + NEW.amount_minor
            WHERE currency = NEW.currency AND scope_kind = b.kind AND scope_key = b.key AND utc_day = NEW.utc_day;
        END LOOP;
        RETURN NEW;
      END $$
    `.execute(db)
    await sql`CREATE TRIGGER procurement_risk_reservation_guard BEFORE INSERT ON procurement_risk_reservations FOR EACH ROW EXECUTE FUNCTION procurement_risk_reserve()`.execute(db)
    await sql`
      CREATE FUNCTION procurement_risk_append_reserve() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO procurement_risk_events(id, operation_id, currency, kind, amount_minor)
          VALUES (gen_random_uuid(), NEW.operation_id, NEW.currency, 'reserve', NEW.amount_minor);
        RETURN NEW;
      END $$
    `.execute(db)
    await sql`CREATE TRIGGER procurement_risk_reservation_event AFTER INSERT ON procurement_risk_reservations FOR EACH ROW EXECUTE FUNCTION procurement_risk_append_reserve()`.execute(db)
    for (const table of ['procurement_risk_reservations', 'procurement_risk_events']) {
      await sql.raw(`CREATE TRIGGER ${table}_immutable BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION protect_order_purchase_immutable()`).execute(db)
      await sql.raw(`CREATE TRIGGER ${table}_no_truncate BEFORE TRUNCATE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION protect_order_purchase_immutable()`).execute(db)
    }
  },
  async down(db) {
    await sql`DO $$ BEGIN IF EXISTS (SELECT 1 FROM procurement_risk_reservations) THEN RAISE EXCEPTION 'Cannot remove risk history'; END IF; END $$`.execute(db)
    await sql`DROP TABLE procurement_risk_events`.execute(db)
    await sql`DROP TABLE procurement_risk_reservations`.execute(db)
    await sql`DROP TABLE procurement_risk_daily`.execute(db)
    await sql`DROP TABLE procurement_risk_buckets`.execute(db)
    await sql`DROP TABLE procurement_risk_policies`.execute(db)
    await sql`DROP FUNCTION procurement_risk_append_reserve()`.execute(db)
    await sql`DROP FUNCTION procurement_risk_reserve()`.execute(db)
    await sql`DROP FUNCTION procurement_risk_apply_event()`.execute(db)
    await sql`DROP FUNCTION procurement_risk_reinstate_from_evidence(uuid)`.execute(db)
    await sql`DROP FUNCTION procurement_risk_note_from_evidence(uuid)`.execute(db)
    await sql`DROP FUNCTION procurement_risk_note_from_review(uuid, integer)`.execute(db)
    await sql`DROP FUNCTION procurement_risk_policy_guard()`.execute(db)
    await sql`DROP FUNCTION procurement_risk_counter_guard()`.execute(db)
  },
}
