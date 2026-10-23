import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

/** Forward-only: preserve all phase 5 ciphertext, versions and operation identities. */
export const kayixinReadonlyMigration: Migration = {
  async up(db) {
    await sql`ALTER TABLE supplier_connections
      ADD COLUMN provider_type varchar(32) NOT NULL DEFAULT 'http_json_v1',
      ADD CONSTRAINT supplier_connection_protocol_check CHECK (provider_type IN ('http_json_v1', 'kayixin_customer_v3')),
      ADD CONSTRAINT supplier_connection_protocol_unique UNIQUE (id, provider_type)`.execute(db)
    await sql`ALTER TABLE supplier_connection_credentials
      ADD COLUMN provider_type varchar(32) NOT NULL DEFAULT 'http_json_v1',
      ADD COLUMN auth_scheme varchar(16) NOT NULL DEFAULT 'bearer',
      ADD CONSTRAINT supplier_credential_protocol_auth_check CHECK (
        (provider_type = 'http_json_v1' AND auth_scheme = 'bearer') OR
        (provider_type = 'kayixin_customer_v3' AND auth_scheme = 'app_signature_v3')),
      ADD CONSTRAINT supplier_credential_connection_protocol_fkey FOREIGN KEY (supplier_connection_id, provider_type)
        REFERENCES supplier_connections (id, provider_type) ON DELETE RESTRICT,
      ADD CONSTRAINT supplier_credential_protocol_unique UNIQUE (supplier_connection_id, credential_version, provider_type, auth_scheme)`.execute(db)
    await sql`ALTER TABLE supplier_connection_versions
      DROP CONSTRAINT supplier_connection_versions_provider_check,
      DROP CONSTRAINT supplier_connection_versions_auth_check,
      ADD CONSTRAINT supplier_version_protocol_auth_check CHECK (
        (provider_type = 'http_json_v1' AND auth_scheme = 'bearer') OR
        (provider_type = 'kayixin_customer_v3' AND auth_scheme = 'app_signature_v3')),
      ADD CONSTRAINT supplier_version_connection_protocol_fkey FOREIGN KEY (supplier_connection_id, provider_type)
        REFERENCES supplier_connections (id, provider_type) ON DELETE RESTRICT,
      ADD CONSTRAINT supplier_version_credential_protocol_fkey FOREIGN KEY (supplier_connection_id, credential_version, provider_type, auth_scheme)
        REFERENCES supplier_connection_credentials (supplier_connection_id, credential_version, provider_type, auth_scheme) ON DELETE RESTRICT,
      ADD CONSTRAINT supplier_version_protocol_unique UNIQUE (id, supplier_connection_id, provider_type)`.execute(db)
    await sql`CREATE OR REPLACE FUNCTION guard_supplier_connection_credential() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'Supplier credentials are retained for historical orders'
            USING ERRCODE = '23514', CONSTRAINT = 'supplier_credential_history_immutable';
        END IF;
        IF ROW(NEW.supplier_connection_id, NEW.credential_version, NEW.created_at, NEW.provider_type, NEW.auth_scheme)
          IS DISTINCT FROM ROW(OLD.supplier_connection_id, OLD.credential_version, OLD.created_at, OLD.provider_type, OLD.auth_scheme)
          OR ROW(NEW.key_id, NEW.nonce, NEW.ciphertext, NEW.auth_tag)
            IS NOT DISTINCT FROM ROW(OLD.key_id, OLD.nonce, OLD.ciphertext, OLD.auth_tag) THEN
          RAISE EXCEPTION 'Supplier credential identity is immutable; rewrap must replace its envelope'
            USING ERRCODE = '23514', CONSTRAINT = 'supplier_credential_identity_immutable';
        END IF;
        RETURN NEW;
      END $$`.execute(db)
    // Add to the existing version monotonicity/test invalidation trigger, rather than replacing its rules.
    await sql`CREATE FUNCTION guard_supplier_protocol() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF TG_OP = 'UPDATE' AND NEW.provider_type IS DISTINCT FROM OLD.provider_type THEN
        RAISE EXCEPTION 'A new protocol requires a new connection'
          USING ERRCODE = '23514', CONSTRAINT = 'supplier_connection_protocol_immutable';
      END IF;
      IF NEW.provider_type <> 'http_json_v1' AND (NEW.enabled OR NEW.tested_version_id IS NOT NULL) THEN
        RAISE EXCEPTION 'Read-only protocol cannot acquire fulfillment readiness'
          USING ERRCODE = '23514', CONSTRAINT = 'supplier_protocol_readonly';
      END IF;
      IF NEW.enabled AND (NEW.current_version_id IS NULL OR NEW.tested_version_id IS DISTINCT FROM NEW.current_version_id) THEN
        RAISE EXCEPTION 'Current version must pass its fulfillment test'
          USING ERRCODE = '23514', CONSTRAINT = 'supplier_connection_test_required';
      END IF;
      RETURN NEW;
    END $$`.execute(db)
    await sql`CREATE TRIGGER supplier_connections_protocol_guard BEFORE INSERT OR UPDATE ON supplier_connections
      FOR EACH ROW EXECUTE FUNCTION guard_supplier_protocol()`.execute(db)
    await sql`CREATE FUNCTION guard_supplier_fulfillment_protocol() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE protocol varchar(32);
      BEGIN
        SELECT provider_type INTO protocol FROM supplier_connection_versions WHERE id = NEW.supplier_connection_version_id;
        IF protocol IS DISTINCT FROM 'http_json_v1' THEN
          RAISE EXCEPTION 'Only implemented fulfillment protocols may back API sales or operations'
            USING ERRCODE = '23514', CONSTRAINT = 'supplier_protocol_readonly';
        END IF;
        RETURN NEW;
      END $$`.execute(db)
    await sql`CREATE TRIGGER fulfillment_versions_supplier_protocol_guard BEFORE INSERT ON product_variant_fulfillment_versions
      FOR EACH ROW WHEN (NEW.method = 'api') EXECUTE FUNCTION guard_supplier_fulfillment_protocol()`.execute(db)
    await sql`CREATE TRIGGER supplier_operations_protocol_guard BEFORE INSERT ON supplier_api_delivery_operations
      FOR EACH ROW EXECUTE FUNCTION guard_supplier_fulfillment_protocol()`.execute(db)
    await sql`CREATE FUNCTION guard_api_config_supplier_protocol() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE protocol varchar(32);
      BEGIN
        SELECT connection.provider_type INTO protocol FROM product_variant_fulfillment_versions version
          JOIN supplier_connection_versions connection ON connection.id = version.supplier_connection_version_id
          WHERE version.id = NEW.current_content_version_id AND version.method = 'api';
        IF protocol IS DISTINCT FROM 'http_json_v1' THEN
          RAISE EXCEPTION 'Read-only supplier cannot back API fulfillment configuration'
            USING ERRCODE = '23514', CONSTRAINT = 'supplier_protocol_readonly';
        END IF;
        RETURN NEW;
      END $$`.execute(db)
    await sql`CREATE TRIGGER api_config_supplier_protocol_guard BEFORE INSERT OR UPDATE ON product_variant_fulfillment
      FOR EACH ROW WHEN (NEW.method = 'api') EXECUTE FUNCTION guard_api_config_supplier_protocol()`.execute(db)
    await sql`CREATE TABLE supplier_connection_tests (
      id uuid PRIMARY KEY,
      supplier_connection_id uuid NOT NULL,
      configuration_version_id uuid NOT NULL,
      provider_type varchar(32) NOT NULL,
      scope varchar(32) NOT NULL,
      passed boolean NOT NULL,
      error_code varchar(64),
      checked_at timestamptz NOT NULL,
      administrator_id uuid NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT,
      CONSTRAINT supplier_test_scope_check CHECK (
        (provider_type = 'http_json_v1' AND scope = 'fulfillment_v1') OR
        (provider_type = 'kayixin_customer_v3' AND scope = 'catalog_read_v3')),
      CONSTRAINT supplier_test_error_check CHECK ((passed AND error_code IS NULL) OR
        (NOT passed AND error_code IS NOT NULL AND error_code ~ '^[A-Za-z0-9_-]{1,64}$')),
      CONSTRAINT supplier_test_version_fkey FOREIGN KEY (configuration_version_id, supplier_connection_id, provider_type)
        REFERENCES supplier_connection_versions(id, supplier_connection_id, provider_type) ON DELETE RESTRICT
    )`.execute(db)
    await sql`CREATE INDEX supplier_test_current_idx ON supplier_connection_tests(configuration_version_id, checked_at DESC, id DESC)`.execute(db)
    await sql`CREATE TRIGGER supplier_tests_immutable BEFORE UPDATE OR DELETE ON supplier_connection_tests
      FOR EACH ROW EXECUTE FUNCTION protect_supplier_api_audit_history()`.execute(db)
    await sql`CREATE TRIGGER supplier_tests_prevent_truncate BEFORE TRUNCATE ON supplier_connection_tests
      FOR EACH STATEMENT EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)
  },
}
