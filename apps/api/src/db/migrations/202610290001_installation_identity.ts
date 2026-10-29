import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

export const installationIdentityMigration: Migration = {
  async up(db) {
    await sql.raw(`
      CREATE TABLE installation_identity_initializations (
        singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
        operation_id uuid NOT NULL UNIQUE,
        mode varchar(24) NOT NULL,
        state varchar(24) NOT NULL DEFAULT 'preparing',
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        committed_at timestamptz,
        CONSTRAINT installation_identity_initializations_mode_check
          CHECK (mode IN ('fresh', 'adopt_existing')),
        CONSTRAINT installation_identity_initializations_state_check
          CHECK (state IN ('preparing', 'identity_material_saved', 'identity_staged', 'committed')),
        CONSTRAINT installation_identity_initializations_commit_check
          CHECK ((state = 'committed' AND committed_at IS NOT NULL)
            OR (state <> 'committed' AND committed_at IS NULL))
      )
    `).execute(db)

    await sql.raw(`
      CREATE TABLE installation_binding (
        singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
        database_id uuid NOT NULL UNIQUE,
        instance_id uuid NOT NULL UNIQUE,
        identity_jkt char(43) NOT NULL,
        binding_revision bigint NOT NULL DEFAULT 1,
        binding_state varchar(24) NOT NULL DEFAULT 'ready',
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT installation_binding_database_id_v4_check CHECK (
          substring(database_id::text, 15, 1) = '4'
          AND substring(database_id::text, 20, 1) IN ('8', '9', 'a', 'b')
        ),
        CONSTRAINT installation_binding_instance_id_v4_check CHECK (
          substring(instance_id::text, 15, 1) = '4'
          AND substring(instance_id::text, 20, 1) IN ('8', '9', 'a', 'b')
        ),
        CONSTRAINT installation_binding_jkt_check CHECK (identity_jkt ~ '^[A-Za-z0-9_-]{43}$'),
        CONSTRAINT installation_binding_revision_check CHECK (binding_revision >= 1),
        CONSTRAINT installation_binding_state_check CHECK (binding_state IN ('ready', 'rebind_pending'))
      )
    `).execute(db)

    await sql.raw(`
      CREATE FUNCTION guard_installation_identity_initialization()
      RETURNS trigger LANGUAGE plpgsql AS $function$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'installation initialization history is immutable'
            USING ERRCODE = '55000', CONSTRAINT = 'installation_identity_initializations_immutable';
        END IF;
        IF TG_OP = 'UPDATE' THEN
          IF OLD.singleton IS DISTINCT FROM NEW.singleton
            OR OLD.operation_id IS DISTINCT FROM NEW.operation_id
            OR OLD.mode IS DISTINCT FROM NEW.mode
            OR OLD.created_at IS DISTINCT FROM NEW.created_at
            OR NOT (
              (OLD.state = 'preparing' AND NEW.state IN ('identity_material_saved', 'identity_staged'))
              OR (OLD.state = 'identity_material_saved' AND NEW.state = 'identity_staged')
              OR (OLD.state = 'identity_staged' AND NEW.state = 'committed')
            )
            OR (NEW.state <> 'committed' AND NEW.committed_at IS NOT NULL)
            OR (NEW.state = 'committed' AND NEW.committed_at IS NULL) THEN
            RAISE EXCEPTION 'installation initialization state cannot be changed or downgraded'
              USING ERRCODE = '55000', CONSTRAINT = 'installation_identity_initializations_immutable';
          END IF;
        END IF;
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
      END
      $function$
    `).execute(db)
    await sql.raw(`
      CREATE TRIGGER installation_identity_initializations_guard
      BEFORE UPDATE OR DELETE ON installation_identity_initializations
      FOR EACH ROW EXECUTE FUNCTION guard_installation_identity_initialization()
    `).execute(db)
    await sql.raw(`
      CREATE FUNCTION prevent_installation_identity_history_truncate()
      RETURNS trigger LANGUAGE plpgsql AS $function$
      BEGIN
        RAISE EXCEPTION 'installation identity history cannot be truncated'
          USING ERRCODE = '55000', CONSTRAINT = 'installation_identity_truncate_forbidden';
      END
      $function$
    `).execute(db)
    await sql.raw(`
      CREATE TRIGGER installation_identity_initializations_no_truncate
      BEFORE TRUNCATE ON installation_identity_initializations
      FOR EACH STATEMENT EXECUTE FUNCTION prevent_installation_identity_history_truncate()
    `).execute(db)

    await sql.raw(`
      CREATE FUNCTION guard_installation_binding_insert()
      RETURNS trigger LANGUAGE plpgsql AS $function$
      DECLARE initialization_state varchar(24);
      BEGIN
        SELECT state INTO initialization_state
          FROM installation_identity_initializations
          WHERE singleton = true
          FOR UPDATE;
        IF initialization_state IS DISTINCT FROM 'identity_staged'
          OR NEW.binding_revision <> 1
          OR NEW.binding_state <> 'ready' THEN
          RAISE EXCEPTION 'installation binding requires durable staged identity material'
            USING ERRCODE = '55000', CONSTRAINT = 'installation_binding_requires_staged_identity';
        END IF;
        RETURN NEW;
      END
      $function$
    `).execute(db)
    await sql.raw(`
      CREATE TRIGGER installation_binding_insert_guard
      BEFORE INSERT ON installation_binding
      FOR EACH ROW EXECUTE FUNCTION guard_installation_binding_insert()
    `).execute(db)
    await sql.raw(`
      CREATE FUNCTION guard_installation_binding_mutation()
      RETURNS trigger LANGUAGE plpgsql AS $function$
      BEGIN
        RAISE EXCEPTION 'installation binding is immutable outside a future audited rebind migration'
          USING ERRCODE = '55000', CONSTRAINT = 'installation_binding_immutable';
      END
      $function$
    `).execute(db)
    await sql.raw(`
      CREATE TRIGGER installation_binding_no_mutation
      BEFORE UPDATE OR DELETE ON installation_binding
      FOR EACH ROW EXECUTE FUNCTION guard_installation_binding_mutation()
    `).execute(db)
    await sql.raw(`
      CREATE TRIGGER installation_binding_no_truncate
      BEFORE TRUNCATE ON installation_binding
      FOR EACH STATEMENT EXECUTE FUNCTION prevent_installation_identity_history_truncate()
    `).execute(db)
  },
}
