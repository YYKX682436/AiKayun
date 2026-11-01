import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

/** Adds only the durable time floor to the existing singleton license projection. */
export const trustedLicenseTimeWatermarkMigration: Migration = {
  async up(db) {
    await sql.raw(`
      ALTER TABLE instance_license_state
        ADD COLUMN trusted_time_high_water_ms bigint,
        ADD CONSTRAINT instance_license_state_time_watermark_check
          CHECK (trusted_time_high_water_ms IS NULL OR trusted_time_high_water_ms > 0);

      CREATE FUNCTION guard_instance_license_time_watermark() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.trusted_time_high_water_ms IS NOT NULL AND
          (NEW.trusted_time_high_water_ms IS NULL OR NEW.trusted_time_high_water_ms < OLD.trusted_time_high_water_ms) THEN
          RAISE EXCEPTION 'trusted license time watermark cannot decrease' USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END
      $$;
      CREATE TRIGGER instance_license_time_watermark_guard
        BEFORE UPDATE ON instance_license_state
        FOR EACH ROW EXECUTE FUNCTION guard_instance_license_time_watermark();
    `).execute(db)
  },
}
