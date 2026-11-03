import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

/** Bind the create-once Pending AES key to the existing instance/database identity. */
export const licensePendingKeyBindingMigration: Migration = {
  async up(db) {
    await sql.raw(`
      ALTER TABLE installation_binding
        ADD COLUMN pending_key_id varchar(48),
        ADD COLUMN pending_key_sha256 char(64),
        ADD CONSTRAINT installation_binding_pending_key_pair_check CHECK (
          (pending_key_id IS NULL AND pending_key_sha256 IS NULL) OR
          (pending_key_id ~ '^lp-[a-f0-9]{32}$' AND pending_key_sha256 ~ '^[a-f0-9]{64}$')
        );

      CREATE OR REPLACE FUNCTION guard_installation_binding_mutation()
      RETURNS trigger LANGUAGE plpgsql AS $function$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'installation binding and Pending Key binding are immutable'
            USING ERRCODE = '55000', CONSTRAINT = 'installation_binding_immutable';
        END IF;
        IF (NEW.singleton, NEW.database_id, NEW.instance_id, NEW.identity_jkt,
            NEW.binding_revision, NEW.binding_state, NEW.created_at)
            IS DISTINCT FROM
          (OLD.singleton, OLD.database_id, OLD.instance_id, OLD.identity_jkt,
            OLD.binding_revision, OLD.binding_state, OLD.created_at) OR
          OLD.pending_key_id IS NOT NULL OR OLD.pending_key_sha256 IS NOT NULL OR
          NEW.pending_key_id IS NULL OR NEW.pending_key_sha256 IS NULL OR
          NEW.pending_key_id !~ '^lp-[a-f0-9]{32}$' OR NEW.pending_key_sha256 !~ '^[a-f0-9]{64}$' THEN
          RAISE EXCEPTION 'installation binding and Pending Key binding are immutable'
            USING ERRCODE = '55000', CONSTRAINT = 'installation_binding_immutable';
        END IF;
        RETURN NEW;
      END
      $function$;
    `).execute(db)
  },
}
