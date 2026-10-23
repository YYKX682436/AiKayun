import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

/** Adds HTTP JSON v1 suppliers to the existing immutable fulfillment-version and order state machine. */
export const externalApiDeliveryMigration: Migration = {
  async up(db) {
    await sql`
      CREATE TABLE supplier_connections (
        id uuid PRIMARY KEY,
        display_name varchar(120) NOT NULL,
        enabled boolean NOT NULL DEFAULT false,
        current_version_id uuid,
        tested_version_id uuid,
        created_by_admin_id uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT supplier_connections_name_check CHECK (btrim(display_name) <> '' AND char_length(display_name) <= 120),
        CONSTRAINT supplier_connections_admin_fkey FOREIGN KEY (created_by_admin_id)
          REFERENCES admin_users (id) ON DELETE RESTRICT
      )
    `.execute(db)

    await sql`
      CREATE TABLE supplier_connection_credentials (
        supplier_connection_id uuid NOT NULL,
        credential_version integer NOT NULL,
        key_id varchar(48) NOT NULL,
        nonce bytea NOT NULL,
        ciphertext bytea NOT NULL,
        auth_tag bytea NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT supplier_connection_credentials_pk PRIMARY KEY (supplier_connection_id, credential_version),
        CONSTRAINT supplier_connection_credentials_connection_fkey FOREIGN KEY (supplier_connection_id)
          REFERENCES supplier_connections (id) ON DELETE RESTRICT,
        CONSTRAINT supplier_connection_credentials_version_check CHECK (credential_version > 0),
        CONSTRAINT supplier_connection_credentials_key_check CHECK (key_id ~ '^[A-Za-z0-9_-]{1,48}$'),
        CONSTRAINT supplier_connection_credentials_nonce_check CHECK (octet_length(nonce) = 12),
        CONSTRAINT supplier_connection_credentials_ciphertext_check CHECK (octet_length(ciphertext) BETWEEN 1 AND 4096),
        CONSTRAINT supplier_connection_credentials_tag_check CHECK (octet_length(auth_tag) = 16)
      )
    `.execute(db)

    await sql`
      CREATE TABLE supplier_connection_versions (
        id uuid PRIMARY KEY,
        supplier_connection_id uuid NOT NULL,
        version_number integer NOT NULL,
        display_name varchar(120) NOT NULL,
        provider_type varchar(32) NOT NULL,
        base_url varchar(2048) NOT NULL,
        auth_scheme varchar(16) NOT NULL,
        credential_version integer NOT NULL,
        created_by_admin_id uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT supplier_connection_versions_connection_fkey FOREIGN KEY (supplier_connection_id)
          REFERENCES supplier_connections (id) ON DELETE RESTRICT,
        CONSTRAINT supplier_connection_versions_credentials_fkey
          FOREIGN KEY (supplier_connection_id, credential_version)
          REFERENCES supplier_connection_credentials (supplier_connection_id, credential_version) ON DELETE RESTRICT,
        CONSTRAINT supplier_connection_versions_admin_fkey FOREIGN KEY (created_by_admin_id)
          REFERENCES admin_users (id) ON DELETE RESTRICT,
        CONSTRAINT supplier_connection_versions_number_check CHECK (version_number > 0),
        CONSTRAINT supplier_connection_versions_name_check CHECK (btrim(display_name) <> '' AND char_length(display_name) <= 120),
        CONSTRAINT supplier_connection_versions_provider_check CHECK (provider_type = 'http_json_v1'),
        CONSTRAINT supplier_connection_versions_url_check CHECK (btrim(base_url) <> '' AND char_length(base_url) <= 2048),
        CONSTRAINT supplier_connection_versions_auth_check CHECK (auth_scheme = 'bearer'),
        CONSTRAINT supplier_connection_versions_unique UNIQUE (supplier_connection_id, version_number),
        CONSTRAINT supplier_connection_versions_id_connection_unique UNIQUE (id, supplier_connection_id)
      )
    `.execute(db)
    await sql`ALTER TABLE supplier_connections
      ADD CONSTRAINT supplier_connections_current_version_fkey
      FOREIGN KEY (current_version_id, id)
      REFERENCES supplier_connection_versions (id, supplier_connection_id) ON DELETE RESTRICT`.execute(db)
    await sql`ALTER TABLE supplier_connections
      ADD CONSTRAINT supplier_connections_tested_version_fkey
      FOREIGN KEY (tested_version_id, id)
      REFERENCES supplier_connection_versions (id, supplier_connection_id) ON DELETE RESTRICT`.execute(db)
    await sql`CREATE INDEX supplier_connection_versions_history_idx
      ON supplier_connection_versions (supplier_connection_id, version_number DESC)`.execute(db)

    await sql`
      CREATE TABLE supplier_connection_audit_events (
        id uuid PRIMARY KEY,
        supplier_connection_id uuid NOT NULL,
        administrator_id uuid NOT NULL,
        action varchar(32) NOT NULL,
        details jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT supplier_connection_audit_connection_fkey FOREIGN KEY (supplier_connection_id)
          REFERENCES supplier_connections (id) ON DELETE RESTRICT,
        CONSTRAINT supplier_connection_audit_admin_fkey FOREIGN KEY (administrator_id)
          REFERENCES admin_users (id) ON DELETE RESTRICT,
        CONSTRAINT supplier_connection_audit_action_check CHECK (action IN (
          'created', 'configuration_updated', 'credential_rotated', 'credential_key_rewrapped',
          'enabled', 'disabled', 'connection_test_succeeded', 'connection_test_failed'
        )),
        CONSTRAINT supplier_connection_audit_details_check CHECK (jsonb_typeof(details) = 'object')
      )
    `.execute(db)
    await sql`CREATE INDEX supplier_connection_audit_history_idx
      ON supplier_connection_audit_events (supplier_connection_id, created_at DESC, id DESC)`.execute(db)

    await sql`
      CREATE TABLE api_fulfillment_audit_events (
        id uuid PRIMARY KEY,
        product_variant_id uuid,
        fulfillment_version_id uuid,
        supplier_connection_id uuid,
        administrator_id uuid NOT NULL,
        action varchar(32) NOT NULL,
        details jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT api_fulfillment_audit_variant_fkey FOREIGN KEY (product_variant_id)
          REFERENCES product_variants (id) ON DELETE RESTRICT,
        CONSTRAINT api_fulfillment_audit_version_fkey FOREIGN KEY (fulfillment_version_id)
          REFERENCES product_variant_fulfillment_versions (id) ON DELETE RESTRICT,
        CONSTRAINT api_fulfillment_audit_connection_fkey FOREIGN KEY (supplier_connection_id)
          REFERENCES supplier_connections (id) ON DELETE RESTRICT,
        CONSTRAINT api_fulfillment_audit_admin_fkey FOREIGN KEY (administrator_id)
          REFERENCES admin_users (id) ON DELETE RESTRICT,
        CONSTRAINT api_fulfillment_audit_action_check CHECK (action IN (
          'version_saved', 'automatic_delivery_enabled', 'automatic_delivery_paused'
        )),
        CONSTRAINT api_fulfillment_audit_details_check CHECK (jsonb_typeof(details) = 'object')
      )
    `.execute(db)
    await sql`CREATE INDEX api_fulfillment_audit_variant_history_idx
      ON api_fulfillment_audit_events (product_variant_id, created_at DESC, id DESC)`.execute(db)

    await sql`
      ALTER TABLE product_variant_fulfillment_versions
        ADD COLUMN supplier_connection_version_id uuid,
        ADD COLUMN supplier_product_id varchar(200),
        ADD COLUMN supplier_parameters jsonb,
        DROP CONSTRAINT product_variant_fulfillment_versions_method_check,
        DROP CONSTRAINT product_variant_fulfillment_versions_content_shape_check,
        ADD CONSTRAINT product_variant_fulfillment_versions_method_check
          CHECK (method IN ('fixed_content', 'link', 'file', 'api')),
        ADD CONSTRAINT product_variant_fulfillment_versions_api_connection_fkey
          FOREIGN KEY (supplier_connection_version_id) REFERENCES supplier_connection_versions (id) ON DELETE RESTRICT,
        ADD CONSTRAINT product_variant_fulfillment_versions_content_shape_check CHECK (
          (method IN ('fixed_content', 'link')
            AND encrypted_content IS NOT NULL AND octet_length(encrypted_content) BETWEEN 1 AND 65536
            AND content_nonce IS NOT NULL AND octet_length(content_nonce) = 12
            AND content_auth_tag IS NOT NULL AND octet_length(content_auth_tag) = 16
            AND encryption_key_id IS NOT NULL AND encryption_key_id ~ '^[A-Za-z0-9_-]{1,48}$'
            AND private_file_object_id IS NULL AND display_filename IS NULL
            AND supplier_connection_version_id IS NULL AND supplier_product_id IS NULL AND supplier_parameters IS NULL)
          OR (method = 'file'
            AND encrypted_content IS NULL AND content_nonce IS NULL AND content_auth_tag IS NULL
            AND encryption_key_id IS NULL AND private_file_object_id IS NOT NULL
            AND display_filename IS NOT NULL AND btrim(display_filename) <> '' AND char_length(display_filename) <= 255
            AND supplier_connection_version_id IS NULL AND supplier_product_id IS NULL AND supplier_parameters IS NULL)
          OR (method = 'api'
            AND encrypted_content IS NULL AND content_nonce IS NULL AND content_auth_tag IS NULL AND encryption_key_id IS NULL
            AND private_file_object_id IS NULL AND display_filename IS NULL
            AND supplier_connection_version_id IS NOT NULL
            AND supplier_product_id IS NOT NULL AND btrim(supplier_product_id) <> '' AND char_length(supplier_product_id) <= 200
            AND supplier_parameters IS NOT NULL AND jsonb_typeof(supplier_parameters) = 'object')
        )
    `.execute(db)

    await sql`
      ALTER TABLE product_variant_fulfillment
        DROP CONSTRAINT product_variant_fulfillment_content_version_shape_check,
        DROP CONSTRAINT product_variant_fulfillment_readiness_shape_check,
        ADD CONSTRAINT product_variant_fulfillment_content_version_shape_check CHECK (
          (method IN ('fixed_content', 'link', 'file', 'api') AND current_content_version_id IS NOT NULL)
          OR (method NOT IN ('fixed_content', 'link', 'file', 'api') AND current_content_version_id IS NULL)
        ),
        ADD CONSTRAINT product_variant_fulfillment_readiness_shape_check CHECK (
          (NOT manual_delivery_ready OR method = 'manual')
          AND (NOT code_pool_delivery_ready OR method = 'code_pool')
          AND (NOT automatic_delivery_ready OR method IN ('fixed_content', 'link', 'file', 'api'))
        )
    `.execute(db)
    await sql`
      ALTER TABLE order_items
        DROP CONSTRAINT order_items_fulfillment_version_shape_check,
        ADD CONSTRAINT order_items_fulfillment_version_shape_check CHECK (
          (fulfillment_method_snapshot IN ('fixed_content', 'link', 'file', 'api') AND fulfillment_content_version_id IS NOT NULL)
          OR (fulfillment_method_snapshot NOT IN ('fixed_content', 'link', 'file', 'api') AND fulfillment_content_version_id IS NULL)
        )
    `.execute(db)

    await sql`
      ALTER TABLE order_item_fulfillment_attempts
        DROP CONSTRAINT order_item_fulfillment_attempts_source_check,
        DROP CONSTRAINT order_item_fulfillment_attempts_failure_check,
        ADD CONSTRAINT order_item_fulfillment_attempts_source_check
          CHECK (delivery_source IN ('manual', 'code_pool', 'fixed_content', 'link', 'file', 'api')),
        ADD CONSTRAINT order_item_fulfillment_attempts_failure_check CHECK (
          (failure_code IS NULL AND retry_after IS NULL)
          OR (delivery_source = 'api' AND status = 'failed' AND failure_code IN (
            'API_DELIVERY_DATA_INCONSISTENT', 'API_DELIVERY_KEY_UNAVAILABLE', 'API_DELIVERY_ENCRYPTION_FAILED',
            'API_DELIVERY_PAYMENT_UNRESOLVED', 'API_DELIVERY_SUPPLIER_REJECTED', 'API_DELIVERY_DUPLICATE_RESULT'
          ))
          OR (delivery_source IN ('code_pool', 'fixed_content', 'link', 'file') AND status = 'failed'
            AND failure_code IS NOT NULL AND retry_after IS NOT NULL
            AND ((delivery_source = 'code_pool' AND failure_code IN (
                'CODE_POOL_DATA_INCONSISTENT', 'CODE_POOL_KEY_UNAVAILABLE',
                'CODE_POOL_DECRYPTION_FAILED', 'CODE_POOL_PAYMENT_UNRESOLVED'))
              OR (delivery_source IN ('fixed_content', 'link') AND failure_code IN (
                'FIXED_DELIVERY_DATA_INCONSISTENT', 'FIXED_DELIVERY_KEY_UNAVAILABLE',
                'FIXED_DELIVERY_DECRYPTION_FAILED', 'FIXED_DELIVERY_VERSION_UNAVAILABLE',
                'FIXED_DELIVERY_PAYMENT_UNRESOLVED'))
              OR (delivery_source = 'file' AND failure_code IN (
                'FILE_DELIVERY_DATA_INCONSISTENT', 'FILE_DELIVERY_OBJECT_UNAVAILABLE',
                'FILE_DELIVERY_INTEGRITY_FAILED', 'FILE_DELIVERY_PAYMENT_UNRESOLVED'))))
        )
    `.execute(db)

    await sql`
      CREATE TABLE supplier_api_delivery_operations (
        id uuid PRIMARY KEY,
        fulfillment_attempt_id uuid NOT NULL UNIQUE,
        operation_id uuid NOT NULL UNIQUE,
        unit_index integer NOT NULL,
        supplier_connection_id uuid NOT NULL,
        supplier_connection_version_id uuid NOT NULL,
        supplier_product_id varchar(200) NOT NULL,
        idempotency_key varchar(80) NOT NULL UNIQUE,
        request_sha256 char(64) NOT NULL,
        provider_operation_id varchar(200),
        state varchar(32) NOT NULL DEFAULT 'create_pending',
        next_action_at timestamptz,
        lease_token uuid,
        lease_expires_at timestamptz,
        create_requested_at timestamptz,
        last_query_at timestamptz,
        create_attempt_count integer NOT NULL DEFAULT 0,
        query_attempt_count integer NOT NULL DEFAULT 0,
        last_http_status smallint,
        last_error_code varchar(64),
        last_failure_class varchar(32),
        last_provider_status varchar(24),
        result_type varchar(16),
        result_sha256 char(64),
        result_key_id varchar(48),
        result_nonce bytea,
        result_ciphertext bytea,
        result_auth_tag bytea,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        completed_at timestamptz,
        CONSTRAINT supplier_api_operations_attempt_fkey FOREIGN KEY (fulfillment_attempt_id)
          REFERENCES order_item_fulfillment_attempts (id) ON DELETE RESTRICT,
        CONSTRAINT supplier_api_operations_unit_check CHECK (unit_index > 0),
        CONSTRAINT supplier_api_operations_connection_fkey FOREIGN KEY (supplier_connection_id)
          REFERENCES supplier_connections (id) ON DELETE RESTRICT,
        CONSTRAINT supplier_api_operations_version_fkey FOREIGN KEY (supplier_connection_version_id, supplier_connection_id)
          REFERENCES supplier_connection_versions (id, supplier_connection_id) ON DELETE RESTRICT,
        CONSTRAINT supplier_api_operations_product_check CHECK (btrim(supplier_product_id) <> '' AND char_length(supplier_product_id) <= 200),
        CONSTRAINT supplier_api_operations_idempotency_check CHECK (idempotency_key ~ '^aikayun:[0-9a-f-]{36}$'),
        CONSTRAINT supplier_api_operations_request_hash_check CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
        CONSTRAINT supplier_api_operations_state_check CHECK (state IN (
          'create_pending', 'create_in_flight', 'query_pending', 'query_in_flight', 'processing',
          'unknown', 'succeeded_pending_finalize', 'manual_review', 'succeeded', 'failed'
        )),
        CONSTRAINT supplier_api_operations_counts_check CHECK (create_attempt_count >= 0 AND query_attempt_count >= 0),
        CONSTRAINT supplier_api_operations_http_status_check CHECK (last_http_status IS NULL OR last_http_status BETWEEN 100 AND 599),
        CONSTRAINT supplier_api_operations_provider_id_check CHECK (provider_operation_id IS NULL OR (btrim(provider_operation_id) <> '' AND char_length(provider_operation_id) <= 200)),
        CONSTRAINT supplier_api_operations_result_type_check CHECK (result_type IS NULL OR result_type IN ('code', 'text', 'redemption', 'link', 'completed')),
        CONSTRAINT supplier_api_operations_result_digest_check CHECK (result_sha256 IS NULL OR result_sha256 ~ '^[0-9a-f]{64}$'),
        CONSTRAINT supplier_api_operations_result_envelope_check CHECK (
          (result_type IS NULL AND result_sha256 IS NULL AND result_key_id IS NULL AND result_nonce IS NULL
            AND result_ciphertext IS NULL AND result_auth_tag IS NULL)
          OR (result_type IS NOT NULL AND result_sha256 IS NOT NULL AND result_key_id IS NOT NULL
            AND result_nonce IS NOT NULL AND result_ciphertext IS NOT NULL AND result_auth_tag IS NOT NULL
            AND result_key_id ~ '^[A-Za-z0-9_-]{1,48}$'
            AND octet_length(result_nonce) = 12 AND octet_length(result_ciphertext) BETWEEN 1 AND 65536
            AND octet_length(result_auth_tag) = 16)
        ),
        CONSTRAINT supplier_api_operations_lease_check CHECK (
          ((state IN ('create_in_flight', 'query_in_flight')) AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
          OR (state NOT IN ('create_in_flight', 'query_in_flight') AND lease_token IS NULL AND lease_expires_at IS NULL)
        ),
        CONSTRAINT supplier_api_operations_action_time_check CHECK (
          (state IN ('create_pending', 'query_pending', 'processing', 'unknown', 'succeeded_pending_finalize') AND next_action_at IS NOT NULL)
          OR (state IN ('create_in_flight', 'query_in_flight', 'manual_review', 'succeeded', 'failed') AND next_action_at IS NULL)
        ),
        CONSTRAINT supplier_api_operations_completion_check CHECK (
          (state IN ('succeeded', 'failed') AND completed_at IS NOT NULL)
          OR (state NOT IN ('succeeded', 'failed') AND completed_at IS NULL)
        )
      )
    `.execute(db)
    await sql`CREATE INDEX supplier_api_operations_recovery_idx
      ON supplier_api_delivery_operations (next_action_at, created_at, id)
      WHERE state IN ('create_pending', 'query_pending', 'processing', 'unknown', 'succeeded_pending_finalize')`.execute(db)
    await sql`CREATE INDEX supplier_api_operations_connection_history_idx
      ON supplier_api_delivery_operations (supplier_connection_id, created_at DESC, id DESC)`.execute(db)

    await sql`
      CREATE TABLE supplier_api_delivery_events (
        id uuid PRIMARY KEY,
        operation_id uuid NOT NULL,
        event_type varchar(32) NOT NULL,
        http_status smallint,
        classification varchar(32),
        provider_status varchar(24),
        provider_operation_id varchar(200),
        error_code varchar(64),
        response_sha256 char(64),
        details jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT supplier_api_delivery_events_operation_fkey FOREIGN KEY (operation_id)
          REFERENCES supplier_api_delivery_operations (id) ON DELETE RESTRICT,
        CONSTRAINT supplier_api_delivery_events_type_check CHECK (event_type IN (
          'create_started', 'create_response', 'query_started', 'query_response', 'result_stored',
          'delivery_finalized', 'payment_protection_pending', 'manual_query_requested',
          'manual_retry_requested', 'credential_unavailable', 'integrity_conflict'
        )),
        CONSTRAINT supplier_api_delivery_events_http_status_check CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
        CONSTRAINT supplier_api_delivery_events_response_hash_check CHECK (response_sha256 IS NULL OR response_sha256 ~ '^[0-9a-f]{64}$'),
        CONSTRAINT supplier_api_delivery_events_details_check CHECK (jsonb_typeof(details) = 'object')
      )
    `.execute(db)
    await sql`CREATE INDEX supplier_api_delivery_events_history_idx
      ON supplier_api_delivery_events (operation_id, created_at, id)`.execute(db)

    await sql`
      ALTER TABLE order_item_fulfillment_deliveries
        ADD COLUMN supplier_api_operation_id uuid,
        ADD COLUMN supplier_connection_id uuid,
        ADD COLUMN supplier_product_id varchar(200),
        ADD COLUMN supplier_content_type varchar(16),
        ADD COLUMN supplier_fingerprint_key_id varchar(48),
        DROP CONSTRAINT order_item_fulfillment_deliveries_source_check,
        DROP CONSTRAINT order_item_fulfillment_deliveries_content_check,
        ADD CONSTRAINT order_item_fulfillment_deliveries_api_operation_fkey
          FOREIGN KEY (supplier_api_operation_id) REFERENCES supplier_api_delivery_operations (id) ON DELETE RESTRICT,
        ADD CONSTRAINT order_item_fulfillment_deliveries_supplier_fkey
          FOREIGN KEY (supplier_connection_id) REFERENCES supplier_connections (id) ON DELETE RESTRICT,
        ADD CONSTRAINT order_item_fulfillment_deliveries_source_check
          CHECK (delivery_source IN ('manual', 'code_pool', 'fixed_content', 'link', 'file', 'api')),
        ADD CONSTRAINT order_item_fulfillment_deliveries_content_check CHECK (
          (delivery_source = 'manual' AND started_by_admin_id IS NOT NULL
            AND content IS NOT NULL AND char_length(content) BETWEEN 1 AND 512 AND btrim(content) <> ''
            AND encrypted_content IS NULL AND content_nonce IS NULL AND content_auth_tag IS NULL
            AND encryption_key_id IS NULL AND code_pool_entry_id IS NULL AND fulfillment_content_version_id IS NULL
            AND supplier_api_operation_id IS NULL AND supplier_connection_id IS NULL
            AND supplier_product_id IS NULL AND supplier_content_type IS NULL AND supplier_fingerprint_key_id IS NULL)
          OR (delivery_source = 'code_pool' AND started_by_admin_id IS NULL AND content IS NULL
            AND encrypted_content IS NOT NULL AND content_nonce IS NOT NULL AND octet_length(content_nonce) = 12
            AND content_auth_tag IS NOT NULL AND octet_length(content_auth_tag) = 16
            AND encryption_key_id IS NOT NULL AND encryption_key_id ~ '^[A-Za-z0-9_-]{1,48}$'
            AND code_pool_entry_id IS NOT NULL AND fulfillment_content_version_id IS NULL
            AND supplier_api_operation_id IS NULL AND supplier_connection_id IS NULL
            AND supplier_product_id IS NULL AND supplier_content_type IS NULL AND supplier_fingerprint_key_id IS NULL)
          OR (delivery_source IN ('fixed_content', 'link') AND started_by_admin_id IS NULL AND content IS NULL
            AND encrypted_content IS NOT NULL AND octet_length(encrypted_content) BETWEEN 1 AND 65536
            AND content_nonce IS NOT NULL AND octet_length(content_nonce) = 12
            AND content_auth_tag IS NOT NULL AND octet_length(content_auth_tag) = 16
            AND encryption_key_id IS NOT NULL AND encryption_key_id ~ '^[A-Za-z0-9_-]{1,48}$'
            AND code_pool_entry_id IS NULL AND fulfillment_content_version_id IS NOT NULL
            AND supplier_api_operation_id IS NULL AND supplier_connection_id IS NULL
            AND supplier_product_id IS NULL AND supplier_content_type IS NULL AND supplier_fingerprint_key_id IS NULL)
          OR (delivery_source = 'file' AND started_by_admin_id IS NULL AND content IS NULL
            AND encrypted_content IS NULL AND content_nonce IS NULL AND content_auth_tag IS NULL
            AND encryption_key_id IS NULL AND code_pool_entry_id IS NULL AND fulfillment_content_version_id IS NOT NULL
            AND supplier_api_operation_id IS NULL AND supplier_connection_id IS NULL
            AND supplier_product_id IS NULL AND supplier_content_type IS NULL AND supplier_fingerprint_key_id IS NULL)
          OR (delivery_source = 'api' AND started_by_admin_id IS NULL AND content IS NULL
            AND code_pool_entry_id IS NULL AND fulfillment_content_version_id IS NOT NULL
            AND supplier_api_operation_id IS NOT NULL AND supplier_connection_id IS NOT NULL
            AND supplier_product_id IS NOT NULL AND btrim(supplier_product_id) <> '' AND char_length(supplier_product_id) <= 200
            AND supplier_content_type IN ('code', 'text', 'redemption', 'link', 'completed')
            AND ((supplier_content_type = 'code' AND supplier_fingerprint_key_id ~ '^[A-Za-z0-9_-]{1,48}$')
              OR (supplier_content_type <> 'code' AND supplier_fingerprint_key_id IS NULL))
            AND ((supplier_content_type = 'completed' AND encrypted_content IS NULL AND content_nonce IS NULL
              AND content_auth_tag IS NULL AND encryption_key_id IS NULL)
              OR (supplier_content_type <> 'completed' AND encrypted_content IS NOT NULL
                AND octet_length(encrypted_content) BETWEEN 1 AND 65536
                AND content_nonce IS NOT NULL AND octet_length(content_nonce) = 12
                AND content_auth_tag IS NOT NULL AND octet_length(content_auth_tag) = 16
                AND encryption_key_id IS NOT NULL AND encryption_key_id ~ '^[A-Za-z0-9_-]{1,48}$')))
        )
    `.execute(db)
    await sql`CREATE INDEX order_item_fulfillment_api_operation_idx
      ON order_item_fulfillment_deliveries (supplier_api_operation_id) WHERE supplier_api_operation_id IS NOT NULL`.execute(db)
    await sql`CREATE UNIQUE INDEX order_item_fulfillment_api_code_unique
      ON order_item_fulfillment_deliveries (supplier_connection_id, supplier_product_id, supplier_fingerprint_key_id, content_sha256)
      WHERE delivery_source = 'api' AND supplier_content_type = 'code'`.execute(db)

    await sql`
      CREATE TABLE supplier_api_operations_admin_audit (
        id uuid PRIMARY KEY,
        operation_id uuid NOT NULL,
        administrator_id uuid NOT NULL,
        action varchar(32) NOT NULL,
        details jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT supplier_api_operations_admin_operation_fkey FOREIGN KEY (operation_id)
          REFERENCES supplier_api_delivery_operations (id) ON DELETE RESTRICT,
        CONSTRAINT supplier_api_operations_admin_admin_fkey FOREIGN KEY (administrator_id)
          REFERENCES admin_users (id) ON DELETE RESTRICT,
        CONSTRAINT supplier_api_operations_admin_action_check CHECK (action IN ('query_requested', 'retry_requested')),
        CONSTRAINT supplier_api_operations_admin_details_check CHECK (jsonb_typeof(details) = 'object')
      )
    `.execute(db)
    await sql`CREATE INDEX supplier_api_operations_admin_audit_history_idx
      ON supplier_api_operations_admin_audit (operation_id, created_at, id)`.execute(db)

    await sql`
      CREATE FUNCTION protect_supplier_connection_version() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'Supplier connection versions are immutable history'
          USING ERRCODE = '23514', CONSTRAINT = 'supplier_connection_version_immutable';
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER supplier_connection_versions_immutable
      BEFORE UPDATE OR DELETE ON supplier_connection_versions
      FOR EACH ROW EXECUTE FUNCTION protect_supplier_connection_version()`.execute(db)
    await sql`CREATE TRIGGER supplier_connection_versions_prevent_truncate
      BEFORE TRUNCATE ON supplier_connection_versions FOR EACH STATEMENT EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)
    await sql`
      CREATE FUNCTION guard_supplier_connection_credential() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'Supplier credentials are retained for historical orders'
            USING ERRCODE = '23514', CONSTRAINT = 'supplier_credential_history_immutable';
        END IF;
        IF ROW(NEW.supplier_connection_id, NEW.credential_version, NEW.created_at)
          IS DISTINCT FROM ROW(OLD.supplier_connection_id, OLD.credential_version, OLD.created_at)
          OR ROW(NEW.key_id, NEW.nonce, NEW.ciphertext, NEW.auth_tag)
            IS NOT DISTINCT FROM ROW(OLD.key_id, OLD.nonce, OLD.ciphertext, OLD.auth_tag) THEN
          RAISE EXCEPTION 'Supplier credential identity is immutable; key rewrap must replace its envelope'
            USING ERRCODE = '23514', CONSTRAINT = 'supplier_credential_identity_immutable';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER supplier_connection_credentials_guard
      BEFORE UPDATE OR DELETE ON supplier_connection_credentials
      FOR EACH ROW EXECUTE FUNCTION guard_supplier_connection_credential()`.execute(db)
    await sql`CREATE TRIGGER supplier_connection_credentials_prevent_truncate
      BEFORE TRUNCATE ON supplier_connection_credentials FOR EACH STATEMENT EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)
    await sql`
      CREATE FUNCTION protect_supplier_api_audit_history() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'Supplier operation and configuration audit events are immutable history'
          USING ERRCODE = '23514', CONSTRAINT = 'supplier_api_audit_immutable';
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER supplier_connection_audit_events_immutable
      BEFORE UPDATE OR DELETE ON supplier_connection_audit_events
      FOR EACH ROW EXECUTE FUNCTION protect_supplier_api_audit_history()`.execute(db)
    await sql`CREATE TRIGGER supplier_connection_audit_events_prevent_truncate
      BEFORE TRUNCATE ON supplier_connection_audit_events FOR EACH STATEMENT EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)
    await sql`CREATE TRIGGER api_fulfillment_audit_events_immutable
      BEFORE UPDATE OR DELETE ON api_fulfillment_audit_events
      FOR EACH ROW EXECUTE FUNCTION protect_supplier_api_audit_history()`.execute(db)
    await sql`CREATE TRIGGER api_fulfillment_audit_events_prevent_truncate
      BEFORE TRUNCATE ON api_fulfillment_audit_events FOR EACH STATEMENT EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)
    await sql`CREATE TRIGGER supplier_api_delivery_events_immutable
      BEFORE UPDATE OR DELETE ON supplier_api_delivery_events
      FOR EACH ROW EXECUTE FUNCTION protect_supplier_api_audit_history()`.execute(db)
    await sql`CREATE TRIGGER supplier_api_delivery_events_prevent_truncate
      BEFORE TRUNCATE ON supplier_api_delivery_events FOR EACH STATEMENT EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)
    await sql`CREATE TRIGGER supplier_api_operations_admin_audit_immutable
      BEFORE UPDATE OR DELETE ON supplier_api_operations_admin_audit
      FOR EACH ROW EXECUTE FUNCTION protect_supplier_api_audit_history()`.execute(db)
    await sql`CREATE TRIGGER supplier_api_operations_admin_audit_prevent_truncate
      BEFORE TRUNCATE ON supplier_api_operations_admin_audit FOR EACH STATEMENT EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)

    await sql`
      CREATE FUNCTION guard_supplier_connection_update() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE version_number integer; old_version_number integer;
      BEGIN
        IF TG_OP = 'INSERT' AND NEW.current_version_id IS NULL THEN
          NEW.updated_at := clock_timestamp();
          RETURN NEW;
        END IF;
        SELECT current_version.version_number INTO version_number
        FROM supplier_connection_versions AS current_version
        WHERE current_version.id = NEW.current_version_id
          AND current_version.supplier_connection_id = NEW.id;
        IF version_number IS NULL THEN
          RAISE EXCEPTION 'Supplier current version must belong to its connection'
            USING ERRCODE = '23514', CONSTRAINT = 'supplier_connection_current_version_invalid';
        END IF;
        IF TG_OP = 'UPDATE' THEN
          SELECT current_version.version_number INTO old_version_number
          FROM supplier_connection_versions AS current_version
          WHERE current_version.id = OLD.current_version_id;
          IF version_number < old_version_number THEN
            RAISE EXCEPTION 'Supplier current version cannot move backwards'
              USING ERRCODE = '23514', CONSTRAINT = 'supplier_connection_version_regression';
          END IF;
          IF NEW.current_version_id IS DISTINCT FROM OLD.current_version_id THEN
            NEW.enabled := false;
            NEW.tested_version_id := NULL;
          END IF;
          IF NEW.enabled AND NEW.tested_version_id IS DISTINCT FROM NEW.current_version_id THEN
            RAISE EXCEPTION 'Supplier connection must pass its query capability test before it is enabled'
              USING ERRCODE = '23514', CONSTRAINT = 'supplier_connection_test_required';
          END IF;
          IF ROW(NEW.id, NEW.created_by_admin_id, NEW.created_at)
            IS DISTINCT FROM ROW(OLD.id, OLD.created_by_admin_id, OLD.created_at) THEN
            RAISE EXCEPTION 'Supplier connection identity is immutable'
              USING ERRCODE = '23514', CONSTRAINT = 'supplier_connection_identity_immutable';
          END IF;
        END IF;
        NEW.updated_at := clock_timestamp();
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER supplier_connections_guard
      BEFORE INSERT OR UPDATE ON supplier_connections
      FOR EACH ROW EXECUTE FUNCTION guard_supplier_connection_update()`.execute(db)
    await sql`CREATE TRIGGER supplier_connections_prevent_delete
      BEFORE DELETE ON supplier_connections FOR EACH ROW EXECUTE FUNCTION protect_supplier_connection_version()`.execute(db)

    await sql`
      CREATE FUNCTION guard_supplier_api_operation() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'Supplier API operation history is permanent'
            USING ERRCODE = '23514', CONSTRAINT = 'supplier_api_operation_immutable';
        END IF;
        IF TG_OP = 'UPDATE' AND ROW(NEW.id, NEW.fulfillment_attempt_id, NEW.operation_id,
          NEW.supplier_connection_id, NEW.supplier_connection_version_id, NEW.supplier_product_id,
          NEW.idempotency_key, NEW.request_sha256, NEW.created_at)
          IS DISTINCT FROM ROW(OLD.id, OLD.fulfillment_attempt_id, OLD.operation_id,
          OLD.supplier_connection_id, OLD.supplier_connection_version_id, OLD.supplier_product_id,
          OLD.idempotency_key, OLD.request_sha256, OLD.created_at) THEN
          RAISE EXCEPTION 'Supplier operation identity and request are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'supplier_api_operation_identity_immutable';
        END IF;
        IF OLD.state IN ('succeeded', 'failed') AND NEW IS DISTINCT FROM OLD THEN
          RAISE EXCEPTION 'Completed supplier API operations are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'supplier_api_operation_terminal';
        END IF;
        IF OLD.result_ciphertext IS NOT NULL AND ROW(NEW.result_type, NEW.result_sha256,
          NEW.result_key_id, NEW.result_nonce, NEW.result_ciphertext, NEW.result_auth_tag)
          IS DISTINCT FROM ROW(OLD.result_type, OLD.result_sha256,
          OLD.result_key_id, OLD.result_nonce, OLD.result_ciphertext, OLD.result_auth_tag) THEN
          RAISE EXCEPTION 'A recorded supplier result is immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'supplier_api_operation_result_immutable';
        END IF;
        IF ROW(NEW.create_attempt_count, NEW.query_attempt_count)
          IS DISTINCT FROM ROW(OLD.create_attempt_count, OLD.query_attempt_count)
          AND (NEW.create_attempt_count < OLD.create_attempt_count OR NEW.query_attempt_count < OLD.query_attempt_count) THEN
          RAISE EXCEPTION 'Supplier operation counters cannot decrease'
            USING ERRCODE = '23514', CONSTRAINT = 'supplier_api_operation_counter_regression';
        END IF;
        NEW.updated_at := clock_timestamp();
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER supplier_api_operations_guard
      BEFORE UPDATE OR DELETE ON supplier_api_delivery_operations
      FOR EACH ROW EXECUTE FUNCTION guard_supplier_api_operation()`.execute(db)
    await sql`CREATE TRIGGER supplier_api_operations_prevent_truncate
      BEFORE TRUNCATE ON supplier_api_delivery_operations FOR EACH STATEMENT EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)

    await sql`
      CREATE OR REPLACE FUNCTION guard_fixed_delivery_config() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE sku product_variants%ROWTYPE; product_type varchar(16); supplier_enabled boolean;
      BEGIN
        IF NEW.method IN ('fixed_content', 'link', 'file', 'api') THEN
          SELECT * INTO sku FROM product_variants WHERE id = NEW.product_variant_id;
          SELECT product.product_type INTO product_type FROM products AS product WHERE product.id = sku.product_id;
          IF product_type IS DISTINCT FROM 'digital' OR sku.inventory_mode IS NULL
            OR sku.inventory_mode NOT IN ('quantity', 'unlimited') THEN
            RAISE EXCEPTION 'Automatic delivery requires a digital SKU with quantity or unlimited inventory'
              USING ERRCODE = '23514', CONSTRAINT = 'fixed_delivery_sku_not_supported';
          END IF;
          IF NEW.automatic_delivery_ready AND (NOT sku.enabled OR sku.retired_at IS NOT NULL
            OR NEW.current_content_version_id IS NULL) THEN
            RAISE EXCEPTION 'Automatic delivery requires a saved version and a sellable SKU'
              USING ERRCODE = '23514', CONSTRAINT = 'fixed_delivery_readiness_invalid';
          END IF;
          IF NEW.method = 'api' AND NEW.automatic_delivery_ready THEN
            SELECT connection.enabled AND connection.current_version_id = connection_version.id
              AND connection.tested_version_id = connection_version.id INTO supplier_enabled
            FROM product_variant_fulfillment_versions AS version
            JOIN supplier_connection_versions AS connection_version
              ON connection_version.id = version.supplier_connection_version_id
            JOIN supplier_connections AS connection ON connection.id = connection_version.supplier_connection_id
            WHERE version.id = NEW.current_content_version_id AND version.product_variant_id = NEW.product_variant_id
              AND version.method = 'api';
            IF supplier_enabled IS DISTINCT FROM true THEN
              RAISE EXCEPTION 'API automatic delivery requires an enabled supplier connection'
                USING ERRCODE = '23514', CONSTRAINT = 'api_delivery_supplier_disabled';
            END IF;
          END IF;
        ELSIF NEW.automatic_delivery_ready OR NEW.current_content_version_id IS NOT NULL THEN
          RAISE EXCEPTION 'Only automatic delivery methods can reference fulfillment versions'
            USING ERRCODE = '23514', CONSTRAINT = 'fixed_delivery_method_shape_invalid';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)

    await sql`
      CREATE OR REPLACE FUNCTION validate_order_manual_fulfillment_readiness() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE product_type varchar(16); configured_method varchar(24); manual_ready boolean;
        code_pool_ready boolean; automatic_ready boolean; current_version uuid;
        inventory_mode varchar(16); supplier_enabled boolean; version_method varchar(24); file_status varchar(16);
      BEGIN
        SELECT product.product_type, variant.inventory_mode, fulfillment.method,
          fulfillment.manual_delivery_ready, fulfillment.code_pool_delivery_ready,
          fulfillment.automatic_delivery_ready, fulfillment.current_content_version_id,
          version.method, (connection.enabled AND connection.current_version_id = connection_version.id
            AND connection.tested_version_id = connection_version.id), object.status
          INTO product_type, inventory_mode, configured_method, manual_ready,
            code_pool_ready, automatic_ready, current_version, version_method, supplier_enabled, file_status
        FROM products AS product
        JOIN product_variants AS variant ON variant.product_id = product.id
        LEFT JOIN product_variant_fulfillment AS fulfillment ON fulfillment.product_variant_id = variant.id
        LEFT JOIN product_variant_fulfillment_versions AS version ON version.id = fulfillment.current_content_version_id
        LEFT JOIN supplier_connection_versions AS connection_version ON connection_version.id = version.supplier_connection_version_id
        LEFT JOIN supplier_connections AS connection ON connection.id = connection_version.supplier_connection_id
        LEFT JOIN private_file_objects AS object ON object.id = version.private_file_object_id
        WHERE product.id = NEW.product_id AND variant.id = NEW.product_variant_id;
        IF product_type IS DISTINCT FROM 'digital' OR configured_method IS NULL
          OR NEW.fulfillment_method_snapshot IS DISTINCT FROM configured_method
          OR (configured_method = 'manual' AND manual_ready IS DISTINCT FROM true)
          OR (configured_method = 'code_pool' AND (code_pool_ready IS DISTINCT FROM true OR inventory_mode IS DISTINCT FROM 'quantity'))
          OR (configured_method IN ('fixed_content', 'link', 'file') AND (automatic_ready IS DISTINCT FROM true
            OR current_version IS DISTINCT FROM NEW.fulfillment_content_version_id OR version_method IS DISTINCT FROM configured_method
            OR (configured_method = 'file' AND file_status IS DISTINCT FROM 'available')))
          OR (configured_method = 'api' AND (automatic_ready IS DISTINCT FROM true
            OR current_version IS DISTINCT FROM NEW.fulfillment_content_version_id OR version_method IS DISTINCT FROM 'api'
            OR supplier_enabled IS DISTINCT FROM true))
          OR (configured_method NOT IN ('manual', 'code_pool', 'fixed_content', 'link', 'file', 'api')
            OR (configured_method NOT IN ('fixed_content', 'link', 'file', 'api') AND NEW.fulfillment_content_version_id IS NOT NULL)) THEN
          RAISE EXCEPTION 'Only explicitly ready digital SKU fulfillment configurations can be ordered'
            USING ERRCODE = '23514', CONSTRAINT = 'order_items_digital_fulfillment_not_ready';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)

    await sql`
      CREATE OR REPLACE FUNCTION guard_order_fulfillment_attempt() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE item order_items%ROWTYPE; order_state varchar(24);
      BEGIN
        IF TG_OP = 'INSERT' THEN
          IF NEW.status <> 'processing' OR NEW.completed_at IS NOT NULL THEN
            RAISE EXCEPTION 'A fulfillment attempt must start in processing state'
              USING ERRCODE = '23514', CONSTRAINT = 'order_fulfillment_attempt_initial_state';
          END IF;
          SELECT parent.status INTO order_state FROM orders AS parent
          JOIN order_items AS line ON line.order_id = parent.id WHERE line.id = NEW.order_item_id FOR UPDATE OF parent;
          IF NOT FOUND OR order_state <> 'processing' THEN
            RAISE EXCEPTION 'Only a paid or zero-value processing order can start fulfillment'
              USING ERRCODE = '23514', CONSTRAINT = 'order_fulfillment_requires_processing_order';
          END IF;
          SELECT * INTO item FROM order_items WHERE id = NEW.order_item_id FOR UPDATE;
          IF NEW.quantity > item.quantity - item.fulfilled_quantity - item.fulfillment_reserved_quantity THEN
            RAISE EXCEPTION 'Fulfillment quantity exceeds the unfulfilled order quantity'
              USING ERRCODE = '23514', CONSTRAINT = 'order_fulfillment_quantity_available';
          END IF;
          RETURN NEW;
        END IF;
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'Fulfillment attempts are permanent delivery records'
            USING ERRCODE = '23514', CONSTRAINT = 'order_fulfillment_attempts_immutable';
        END IF;
        IF ROW(NEW.id, NEW.order_item_id, NEW.operation_id, NEW.quantity, NEW.created_at)
          IS DISTINCT FROM ROW(OLD.id, OLD.order_item_id, OLD.operation_id, OLD.quantity, OLD.created_at) THEN
          RAISE EXCEPTION 'Fulfillment attempt identity and quantity are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'order_fulfillment_attempts_identity_immutable';
        END IF;
        IF NEW.result_sha256 IS DISTINCT FROM OLD.result_sha256 AND NOT (
          OLD.result_sha256 IS NULL AND NEW.result_sha256 IS NOT NULL
          AND OLD.status IN ('processing', 'unknown') AND NEW.status IN ('succeeded', 'failed')
        ) THEN
          RAISE EXCEPTION 'Fulfillment result digest is immutable once recorded'
            USING ERRCODE = '23514', CONSTRAINT = 'order_fulfillment_result_immutable';
        END IF;
        IF OLD.status IS DISTINCT FROM NEW.status AND NOT (
          (OLD.status = 'processing' AND NEW.status IN ('unknown', 'succeeded', 'failed'))
          OR (OLD.status = 'unknown' AND NEW.status IN ('processing', 'succeeded', 'failed'))
        ) THEN
          RAISE EXCEPTION 'Illegal fulfillment attempt transition: % to %', OLD.status, NEW.status
            USING ERRCODE = '23514', CONSTRAINT = 'order_fulfillment_attempt_transition';
        END IF;
        IF NEW.status = 'succeeded' AND OLD.status <> 'succeeded' THEN
          IF OLD.result_sha256 IS NULL AND NEW.result_sha256 IS NULL THEN
            RAISE EXCEPTION 'Successful fulfillment requires a result digest'
              USING ERRCODE = '23514', CONSTRAINT = 'order_fulfillment_success_requires_result';
          END IF;
          SELECT * INTO item FROM order_items WHERE id = NEW.order_item_id FOR UPDATE;
          IF NEW.quantity > item.quantity - item.fulfilled_quantity THEN
            RAISE EXCEPTION 'Successful fulfillment would exceed the order quantity'
              USING ERRCODE = '23514', CONSTRAINT = 'order_fulfillment_quantity_exceeded';
          END IF;
        END IF;
        IF NEW.status IN ('succeeded', 'failed') AND OLD.status IS DISTINCT FROM NEW.status THEN
          NEW.completed_at := now();
        ELSIF NEW.status IN ('processing', 'unknown') THEN
          NEW.completed_at := NULL;
        ELSIF NEW.completed_at IS DISTINCT FROM OLD.completed_at THEN
          RAISE EXCEPTION 'Fulfillment completion time is controlled by its state transition'
            USING ERRCODE = '23514', CONSTRAINT = 'order_fulfillment_completed_at_guard';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)

    await sql`
      CREATE OR REPLACE FUNCTION guard_code_pool_fulfillment_attempt() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE method_name varchar(24); delivery_count bigint; parent_status varchar(24);
        order_total numeric(18,2); parent_order uuid; version_id uuid; file_object_status varchar(16);
      BEGIN
        SELECT fulfillment_method_snapshot, fulfillment_content_version_id
          INTO method_name, version_id FROM order_items WHERE id = NEW.order_item_id;
        IF TG_OP = 'INSERT' THEN
          IF NEW.delivery_source IS DISTINCT FROM method_name
            OR (NEW.delivery_source = 'manual' AND NEW.started_by_admin_id IS NULL)
            OR (NEW.delivery_source IN ('code_pool', 'fixed_content', 'link', 'file', 'api') AND NEW.started_by_admin_id IS NOT NULL)
            OR (NEW.delivery_source = 'api' AND NEW.quantity <> 1) THEN
            RAISE EXCEPTION 'Fulfillment attempt source or unit quantity does not match its order item'
              USING ERRCODE = '23514', CONSTRAINT = 'order_fulfillment_source_mismatch';
          END IF;
          RETURN NEW;
        END IF;
        IF ROW(NEW.order_item_id, NEW.operation_id, NEW.quantity, NEW.started_by_admin_id, NEW.delivery_source)
          IS DISTINCT FROM ROW(OLD.order_item_id, OLD.operation_id, OLD.quantity, OLD.started_by_admin_id, OLD.delivery_source) THEN
          RAISE EXCEPTION 'Fulfillment attempt identity and source are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'order_fulfillment_attempts_identity_immutable';
        END IF;
        IF NEW.status = 'succeeded' AND OLD.status IS DISTINCT FROM NEW.status
          AND NEW.delivery_source IN ('code_pool', 'fixed_content', 'link', 'file', 'api') THEN
          SELECT order_row.status, order_row.total_amount, order_row.id
            INTO parent_status, order_total, parent_order
          FROM orders AS order_row JOIN order_items AS item ON item.order_id = order_row.id
          WHERE item.id = NEW.order_item_id;
          IF parent_status IS DISTINCT FROM 'processing'
            OR order_has_unresolved_payment_attempts(parent_order)
            OR EXISTS (SELECT 1 FROM payment_attempts AS payment_attempt
              JOIN payment_provider_reconciliation_cases AS reconciliation
                ON reconciliation.payment_attempt_id = payment_attempt.id
              WHERE payment_attempt.order_id = parent_order AND reconciliation.state = 'open')
            OR (order_total > 0 AND COALESCE((
              SELECT sum(receipt.amount) FROM payment_attempts AS payment_attempt
              JOIN payment_receipts AS receipt ON receipt.payment_attempt_id = payment_attempt.id
              WHERE payment_attempt.order_id = parent_order AND payment_attempt.status = 'succeeded'
                AND receipt.disposition = 'on_time'
            ), 0) <> order_total) THEN
            RAISE EXCEPTION 'Automatic delivery requires confirmed payment and no open reconciliation'
              USING ERRCODE = '23514', CONSTRAINT = 'digital_delivery_payment_required';
          END IF;
          IF NEW.delivery_source = 'code_pool' THEN
            SELECT count(*) INTO delivery_count FROM order_item_fulfillment_deliveries AS delivery
            WHERE delivery.fulfillment_attempt_id = NEW.id AND delivery.delivery_source = 'code_pool'
              AND delivery.encrypted_content IS NOT NULL AND delivery.code_pool_entry_id IS NOT NULL
              AND delivery.fulfillment_content_version_id IS NULL;
            IF delivery_count <> NEW.quantity THEN
              RAISE EXCEPTION 'Code-pool success requires one encrypted delivery per unit'
                USING ERRCODE = '23514', CONSTRAINT = 'code_pool_fulfillment_delivery_required';
            END IF;
          ELSIF NEW.delivery_source IN ('fixed_content', 'link') THEN
            SELECT count(*) INTO delivery_count FROM order_item_fulfillment_deliveries AS delivery
            WHERE delivery.fulfillment_attempt_id = NEW.id AND delivery.delivery_source = NEW.delivery_source
              AND delivery.encrypted_content IS NOT NULL
              AND delivery.fulfillment_content_version_id IS NOT DISTINCT FROM version_id;
            IF version_id IS NULL OR delivery_count <> NEW.quantity THEN
              RAISE EXCEPTION 'Fixed delivery requires one encrypted record per unit and its bound version'
                USING ERRCODE = '23514', CONSTRAINT = 'fixed_delivery_records_required';
            END IF;
          ELSIF NEW.delivery_source = 'file' THEN
            SELECT count(*) INTO delivery_count FROM order_item_fulfillment_deliveries AS delivery
            WHERE delivery.fulfillment_attempt_id = NEW.id AND delivery.delivery_source = 'file'
              AND delivery.content IS NULL AND delivery.encrypted_content IS NULL
              AND delivery.fulfillment_content_version_id IS NOT DISTINCT FROM version_id
              AND EXISTS (SELECT 1 FROM product_variant_fulfillment_versions AS version
                JOIN private_file_objects AS object ON object.id = version.private_file_object_id
                WHERE version.id = delivery.fulfillment_content_version_id AND version.method = 'file'
                  AND object.status = 'available' AND version.content_sha256 = delivery.content_sha256);
            SELECT object.status INTO file_object_status
            FROM product_variant_fulfillment_versions AS version
            JOIN private_file_objects AS object ON object.id = version.private_file_object_id
            WHERE version.id = version_id AND version.method = 'file';
            IF file_object_status IS DISTINCT FROM 'available' OR version_id IS NULL OR delivery_count <> NEW.quantity THEN
              RAISE EXCEPTION 'File delivery requires one available immutable object reference per unit'
                USING ERRCODE = '23514', CONSTRAINT = 'file_delivery_records_required';
            END IF;
          ELSE
            SELECT count(*) INTO delivery_count FROM order_item_fulfillment_deliveries AS delivery
            JOIN supplier_api_delivery_operations AS operation ON operation.id = delivery.supplier_api_operation_id
            WHERE delivery.fulfillment_attempt_id = NEW.id AND delivery.delivery_source = 'api'
              AND delivery.fulfillment_content_version_id IS NOT DISTINCT FROM version_id
              AND operation.fulfillment_attempt_id = NEW.id AND operation.state = 'succeeded_pending_finalize';
            IF NEW.quantity <> 1 OR version_id IS NULL OR delivery_count <> 1 THEN
              RAISE EXCEPTION 'API success requires one supplier-confirmed delivery record bound to its operation and version'
                USING ERRCODE = '23514', CONSTRAINT = 'api_delivery_records_required';
            END IF;
          END IF;
        END IF;
        IF NEW.failure_code IS NOT NULL AND (NEW.delivery_source NOT IN ('code_pool', 'fixed_content', 'link', 'file', 'api')
          OR NEW.status <> 'failed') THEN
          RAISE EXCEPTION 'Only failed automatic attempts can record an automatic failure code'
            USING ERRCODE = '23514', CONSTRAINT = 'order_fulfillment_failure_code_state';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)

    await sql`
      CREATE OR REPLACE FUNCTION guard_code_pool_delivery_record() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE attempt_source varchar(16); item_method varchar(24); entry_state varchar(16);
        entry_item uuid; item_version uuid; attempt_item uuid; file_status varchar(16); file_digest char(64);
        api_attempt uuid; api_state varchar(32); api_connection uuid; api_product varchar(200);
      BEGIN
        SELECT attempt.delivery_source, item.fulfillment_method_snapshot,
          item.fulfillment_content_version_id, attempt.order_item_id
          INTO attempt_source, item_method, item_version, attempt_item
        FROM order_item_fulfillment_attempts AS attempt
        JOIN order_items AS item ON item.id = attempt.order_item_id
        WHERE attempt.id = NEW.fulfillment_attempt_id;
        IF NEW.delivery_source = 'manual' THEN
          IF attempt_source <> 'manual' OR item_method <> 'manual' THEN
            RAISE EXCEPTION 'Manual delivery source does not match its order item'
              USING ERRCODE = '23514', CONSTRAINT = 'order_fulfillment_source_mismatch';
          END IF;
          RETURN NEW;
        END IF;
        IF NEW.delivery_source = 'code_pool' THEN
          SELECT state, order_item_id INTO entry_state, entry_item FROM code_pool_entries
          WHERE id = NEW.code_pool_entry_id FOR UPDATE;
          IF attempt_source <> 'code_pool' OR item_method <> 'code_pool' OR entry_state <> 'reserved'
            OR entry_item IS DISTINCT FROM attempt_item OR NEW.started_by_admin_id IS NOT NULL OR NEW.content IS NOT NULL THEN
            RAISE EXCEPTION 'Encrypted code-pool delivery must reference a reserved entry for its order item'
              USING ERRCODE = '23514', CONSTRAINT = 'code_pool_delivery_entry_mismatch';
          END IF;
          RETURN NEW;
        END IF;
        IF attempt_source IS DISTINCT FROM NEW.delivery_source OR item_method IS DISTINCT FROM NEW.delivery_source
          OR item_version IS DISTINCT FROM NEW.fulfillment_content_version_id
          OR NEW.started_by_admin_id IS NOT NULL OR NEW.content IS NOT NULL OR NEW.code_pool_entry_id IS NOT NULL THEN
          RAISE EXCEPTION 'Automatic delivery must match its order item method and bound version'
            USING ERRCODE = '23514', CONSTRAINT = 'fixed_delivery_version_mismatch';
        END IF;
        IF NEW.delivery_source = 'file' THEN
          IF NEW.encrypted_content IS NOT NULL OR NEW.content_nonce IS NOT NULL
            OR NEW.content_auth_tag IS NOT NULL OR NEW.encryption_key_id IS NOT NULL THEN
            RAISE EXCEPTION 'File delivery history stores a version reference without file bytes'
              USING ERRCODE = '23514', CONSTRAINT = 'file_delivery_reference_only';
          END IF;
          SELECT object.status, version.content_sha256 INTO file_status, file_digest
          FROM product_variant_fulfillment_versions AS version
          JOIN private_file_objects AS object ON object.id = version.private_file_object_id
          WHERE version.id = NEW.fulfillment_content_version_id AND version.method = 'file';
          IF file_status IS DISTINCT FROM 'available' OR file_digest IS DISTINCT FROM NEW.content_sha256 THEN
            RAISE EXCEPTION 'File delivery requires an available immutable object with a matching digest'
              USING ERRCODE = '23514', CONSTRAINT = 'file_delivery_object_not_available';
          END IF;
        ELSIF NEW.delivery_source = 'api' THEN
          SELECT operation.fulfillment_attempt_id, operation.state, operation.supplier_connection_id,
            operation.supplier_product_id INTO api_attempt, api_state, api_connection, api_product
          FROM supplier_api_delivery_operations AS operation WHERE operation.id = NEW.supplier_api_operation_id;
          IF NEW.supplier_api_operation_id IS NULL OR api_attempt IS DISTINCT FROM NEW.fulfillment_attempt_id
            OR api_state IS DISTINCT FROM 'succeeded_pending_finalize'
            OR NEW.supplier_connection_id IS DISTINCT FROM api_connection
            OR NEW.supplier_product_id IS DISTINCT FROM api_product
            OR NEW.supplier_content_type IS NULL THEN
            RAISE EXCEPTION 'API delivery must match a validated supplier operation result'
              USING ERRCODE = '23514', CONSTRAINT = 'api_delivery_operation_mismatch';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)

    await sql`CREATE INDEX order_item_fulfillment_api_retry_idx
      ON order_item_fulfillment_attempts (retry_after, order_item_id)
      WHERE delivery_source = 'api' AND status = 'failed' AND retry_after IS NOT NULL`.execute(db)
  },

  async down() {
    throw new Error('External API fulfillment operations and delivery history are immutable; this migration is forward-only.')
  },
}
