import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

/** One durable, one-way setup gate shared by the web flow and admin:init. */
export const adminSetupStateMigration: Migration = {
  async up(db) {
    await sql.raw(`
      CREATE TABLE admin_setup_state (
        singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
        state text NOT NULL CHECK (state IN ('locked', 'open', 'completed')),
        token_hash char(64),
        token_expires_at timestamptz,
        token_generation bigint NOT NULL DEFAULT 0 CHECK (token_generation >= 0),
        admin_user_id uuid REFERENCES admin_users(id) ON DELETE SET NULL,
        completed_by_session_hash char(64),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        completed_at timestamptz,
        CONSTRAINT admin_setup_state_token_check CHECK (
          (state = 'open' AND token_hash ~ '^[a-f0-9]{64}$' AND token_expires_at IS NOT NULL) OR
          (state <> 'open' AND token_hash IS NULL AND token_expires_at IS NULL)
        ),
        CONSTRAINT admin_setup_state_completed_check CHECK (
          (state = 'completed' AND completed_at IS NOT NULL) OR
          (state <> 'completed' AND completed_at IS NULL)
        ),
        CONSTRAINT admin_setup_state_admin_check CHECK (
          (state <> 'open' OR admin_user_id IS NULL) AND
          (completed_by_session_hash IS NULL OR completed_by_session_hash ~ '^[a-f0-9]{64}$')
        )
      );

      CREATE TABLE admin_setup_sessions (
        session_hash char(64) PRIMARY KEY CHECK (session_hash ~ '^[a-f0-9]{64}$'),
        token_generation bigint NOT NULL CHECK (token_generation > 0),
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );
      CREATE INDEX admin_setup_sessions_expiry_idx ON admin_setup_sessions (expires_at);

      CREATE FUNCTION guard_admin_setup_state() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'administrator setup history is immutable' USING ERRCODE = '55000';
        END IF;
        IF OLD.state = 'completed' AND NEW.state <> 'completed' THEN
          RAISE EXCEPTION 'completed administrator setup cannot be reopened' USING ERRCODE = '55000';
        END IF;
        IF NEW.token_generation < OLD.token_generation THEN
          RAISE EXCEPTION 'administrator setup token generation cannot decrease' USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END
      $$;
      CREATE TRIGGER admin_setup_state_one_way
        BEFORE UPDATE OR DELETE ON admin_setup_state
        FOR EACH ROW EXECUTE FUNCTION guard_admin_setup_state();

      CREATE FUNCTION prevent_admin_setup_state_truncate() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'administrator setup history cannot be truncated' USING ERRCODE = '55000';
      END
      $$;
      CREATE TRIGGER admin_setup_state_no_truncate
        BEFORE TRUNCATE ON admin_setup_state
        FOR EACH STATEMENT EXECUTE FUNCTION prevent_admin_setup_state_truncate();

      INSERT INTO admin_setup_state (singleton, state, admin_user_id, completed_at)
      SELECT true, CASE WHEN EXISTS (SELECT 1 FROM admin_users) THEN 'completed' ELSE 'locked' END,
        (SELECT id FROM admin_users ORDER BY created_at, id LIMIT 1),
        CASE WHEN EXISTS (SELECT 1 FROM admin_users) THEN clock_timestamp() ELSE NULL END;
    `).execute(db)
  },
}
