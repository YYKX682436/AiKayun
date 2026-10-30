import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

export const licenseResultArchivePresenceMigration: Migration = {
  async up(db) {
    await sql.raw(`
      ALTER TABLE local_license_operation_attempts
        ADD COLUMN result_archived boolean NOT NULL DEFAULT false;
      ALTER TABLE local_license_operation_attempts
        ADD CONSTRAINT local_license_result_archive_presence_check CHECK (
          result_archived = (result_key_id IS NOT NULL)
        ) NOT VALID;
      CREATE FUNCTION guard_license_result_archive_presence() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.result_archived AND NOT NEW.result_archived THEN
          RAISE EXCEPTION 'license result archive presence is permanent' USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END
      $$;
      CREATE TRIGGER guard_license_result_archive_presence
        BEFORE UPDATE ON local_license_operation_attempts
        FOR EACH ROW EXECUTE FUNCTION guard_license_result_archive_presence();
      UPDATE local_license_operation_attempts SET result_archived = true
        WHERE result_key_id IS NOT NULL;
      SET CONSTRAINTS ALL IMMEDIATE;
      ALTER TABLE local_license_operation_attempts
        VALIDATE CONSTRAINT local_license_result_archive_presence_check;
    `).execute(db)
  },
}
