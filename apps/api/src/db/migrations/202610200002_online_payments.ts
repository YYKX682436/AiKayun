import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

export const onlinePaymentsMigration: Migration = {
  async up(db) {
    await sql`
      CREATE TABLE payment_channels (
        id uuid PRIMARY KEY,
        provider_type varchar(48) NOT NULL,
        name varchar(80) NOT NULL,
        enabled boolean NOT NULL DEFAULT false,
        payment_methods text[] NOT NULL DEFAULT ARRAY[]::text[],
        display_order integer NOT NULL DEFAULT 0,
        config_ciphertext bytea,
        config_nonce bytea,
        config_auth_tag bytea,
        config_key_id varchar(48),
        credential_version integer NOT NULL DEFAULT 0,
        created_by_admin_id uuid NOT NULL,
        updated_by_admin_id uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT payment_channels_provider_check
          CHECK (provider_type IN ('zpay_epay_v1', 'codepay_unconfigured')),
        CONSTRAINT payment_channels_name_check
          CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
        CONSTRAINT payment_channels_methods_check
          CHECK (cardinality(payment_methods) <= 2
            AND payment_methods <@ ARRAY['alipay', 'wechat']::text[]),
        CONSTRAINT payment_channels_display_order_check
          CHECK (display_order BETWEEN 0 AND 100000),
        CONSTRAINT payment_channels_credential_version_check CHECK (credential_version >= 0),
        CONSTRAINT payment_channels_config_envelope_check CHECK (
          (config_ciphertext IS NULL AND config_nonce IS NULL AND config_auth_tag IS NULL AND config_key_id IS NULL)
          OR (config_ciphertext IS NOT NULL AND config_nonce IS NOT NULL AND octet_length(config_nonce) = 12
            AND config_auth_tag IS NOT NULL AND octet_length(config_auth_tag) = 16
            AND config_key_id IS NOT NULL AND btrim(config_key_id) <> '')
        ),
        CONSTRAINT payment_channels_supported_provider_config_check CHECK (
          (provider_type = 'zpay_epay_v1' AND config_ciphertext IS NOT NULL AND credential_version > 0)
          OR (provider_type = 'codepay_unconfigured' AND enabled = false
            AND cardinality(payment_methods) = 0 AND config_ciphertext IS NULL AND credential_version = 0)
        ),
        CONSTRAINT payment_channels_created_admin_fkey
          FOREIGN KEY (created_by_admin_id) REFERENCES admin_users (id) ON DELETE RESTRICT,
        CONSTRAINT payment_channels_updated_admin_fkey
          FOREIGN KEY (updated_by_admin_id) REFERENCES admin_users (id) ON DELETE RESTRICT
      )
    `.execute(db)
    await sql`CREATE INDEX payment_channels_public_order_idx ON payment_channels (display_order, created_at, id) WHERE enabled = true`.execute(db)

    await sql`
      CREATE TABLE payment_channel_audit_events (
        id uuid PRIMARY KEY,
        payment_channel_id uuid NOT NULL,
        administrator_id uuid NOT NULL,
        action varchar(32) NOT NULL,
        summary jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT payment_channel_audit_channel_fkey
          FOREIGN KEY (payment_channel_id) REFERENCES payment_channels (id) ON DELETE RESTRICT,
        CONSTRAINT payment_channel_audit_admin_fkey
          FOREIGN KEY (administrator_id) REFERENCES admin_users (id) ON DELETE RESTRICT,
        CONSTRAINT payment_channel_audit_action_check
          CHECK (action IN ('created', 'updated', 'encryption_reencrypted')),
        CONSTRAINT payment_channel_audit_summary_check CHECK (jsonb_typeof(summary) = 'object')
      )
    `.execute(db)
    await sql`CREATE INDEX payment_channel_audit_channel_created_idx ON payment_channel_audit_events (payment_channel_id, created_at DESC, id DESC)`.execute(db)
    await sql`CREATE TRIGGER payment_channel_audit_immutable BEFORE UPDATE OR DELETE ON payment_channel_audit_events FOR EACH ROW EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)
    await sql`CREATE TRIGGER payment_channel_audit_prevent_truncate BEFORE TRUNCATE ON payment_channel_audit_events FOR EACH STATEMENT EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)
    await sql`
      CREATE FUNCTION audit_payment_channel_change() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        actor_id uuid;
        event_action varchar(32);
        credentials_changed boolean;
      BEGIN
        actor_id := NULLIF(current_setting('aikayun.admin_id', true), '')::uuid;
        IF actor_id IS NULL THEN
          RAISE EXCEPTION 'Payment channel changes require an administrator audit context'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_channel_audit_actor_required';
        END IF;
        IF TG_OP = 'INSERT' THEN
          event_action := 'created';
          credentials_changed := NEW.config_ciphertext IS NOT NULL;
        ELSE
          credentials_changed := NEW.credential_version IS DISTINCT FROM OLD.credential_version;
          IF NOT credentials_changed AND NEW.config_key_id IS DISTINCT FROM OLD.config_key_id THEN
            event_action := 'encryption_reencrypted';
          ELSE
            event_action := 'updated';
          END IF;
        END IF;
        INSERT INTO payment_channel_audit_events (
          id, payment_channel_id, administrator_id, action, summary
        ) VALUES (
          gen_random_uuid(), NEW.id, actor_id, event_action,
          jsonb_build_object(
            'providerType', NEW.provider_type,
            'name', NEW.name,
            'enabled', NEW.enabled,
            'paymentMethods', to_jsonb(NEW.payment_methods),
            'displayOrder', NEW.display_order,
            'credentialVersion', NEW.credential_version,
            'credentialsChanged', credentials_changed
          )
        );
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER payment_channels_audit AFTER INSERT OR UPDATE ON payment_channels FOR EACH ROW EXECUTE FUNCTION audit_payment_channel_change()`.execute(db)
    await sql`
      CREATE FUNCTION touch_payment_channel_updated_at() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        NEW.updated_at := clock_timestamp();
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER payment_channels_updated_at BEFORE UPDATE ON payment_channels FOR EACH ROW EXECUTE FUNCTION touch_payment_channel_updated_at()`.execute(db)
    await sql`
      CREATE FUNCTION guard_payment_channel_credential_version() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        envelope_changed boolean;
      BEGIN
        IF TG_OP = 'INSERT' THEN
          IF NEW.provider_type = 'zpay_epay_v1' AND NEW.credential_version <> 1 THEN
            RAISE EXCEPTION 'A new payment channel starts with credential version 1'
              USING ERRCODE = '23514', CONSTRAINT = 'payment_channel_initial_credential_version';
          END IF;
          RETURN NEW;
        END IF;
        envelope_changed := ROW(NEW.config_ciphertext, NEW.config_nonce, NEW.config_auth_tag, NEW.config_key_id)
          IS DISTINCT FROM ROW(OLD.config_ciphertext, OLD.config_nonce, OLD.config_auth_tag, OLD.config_key_id);
        IF NEW.credential_version < OLD.credential_version
          OR (NEW.credential_version <> OLD.credential_version
            AND (NEW.credential_version <> OLD.credential_version + 1 OR NOT envelope_changed))
          OR (envelope_changed AND NEW.credential_version = OLD.credential_version
            AND (NEW.config_key_id IS NOT DISTINCT FROM OLD.config_key_id)) THEN
          RAISE EXCEPTION 'Payment credential updates require a new credential version or an encryption rewrap'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_channel_credential_version_guard';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER payment_channels_credential_guard BEFORE INSERT OR UPDATE ON payment_channels FOR EACH ROW EXECUTE FUNCTION guard_payment_channel_credential_version()`.execute(db)

    await sql`
      ALTER TABLE payment_attempts
        ADD COLUMN payment_channel_id uuid,
        ADD COLUMN provider_type_snapshot varchar(48),
        ADD COLUMN payment_method_snapshot varchar(24),
        ADD COLUMN payment_channel_name_snapshot varchar(80),
        ADD COLUMN channel_credential_version integer,
        ADD COLUMN merchant_order_no varchar(32),
        ADD CONSTRAINT payment_attempts_channel_fkey
          FOREIGN KEY (payment_channel_id) REFERENCES payment_channels (id) ON DELETE RESTRICT,
        ADD CONSTRAINT payment_attempts_online_snapshot_check CHECK (
          (payment_channel_id IS NULL AND provider_type_snapshot IS NULL AND payment_method_snapshot IS NULL
            AND payment_channel_name_snapshot IS NULL AND channel_credential_version IS NULL AND merchant_order_no IS NULL)
          OR (source = 'external' AND order_id IS NOT NULL AND payment_channel_id IS NOT NULL
            AND provider_type_snapshot = 'zpay_epay_v1' AND payment_method_snapshot IN ('alipay', 'wechat')
            AND payment_channel_name_snapshot IS NOT NULL AND channel_credential_version > 0
            AND merchant_order_no IS NOT NULL AND merchant_order_no ~ '^[A-Za-z0-9]{20,32}$')
        )
    `.execute(db)
    await sql`CREATE UNIQUE INDEX payment_attempts_merchant_order_no_unique ON payment_attempts (merchant_order_no) WHERE merchant_order_no IS NOT NULL`.execute(db)
    await sql`CREATE INDEX payment_attempts_channel_order_idx ON payment_attempts (payment_channel_id, created_at DESC) WHERE payment_channel_id IS NOT NULL`.execute(db)
    await sql`
      CREATE FUNCTION protect_online_payment_attempt_identity() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF ROW(NEW.payment_channel_id, NEW.provider_type_snapshot, NEW.payment_method_snapshot,
               NEW.payment_channel_name_snapshot, NEW.channel_credential_version, NEW.merchant_order_no)
          IS DISTINCT FROM ROW(OLD.payment_channel_id, OLD.provider_type_snapshot, OLD.payment_method_snapshot,
               OLD.payment_channel_name_snapshot, OLD.channel_credential_version, OLD.merchant_order_no) THEN
          RAISE EXCEPTION 'Online payment channel and provider snapshots are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_attempts_online_snapshot_immutable';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER payment_attempts_online_identity_guard BEFORE UPDATE ON payment_attempts FOR EACH ROW EXECUTE FUNCTION protect_online_payment_attempt_identity()`.execute(db)

    await sql`
      CREATE TABLE payment_attempt_secrets (
        payment_attempt_id uuid NOT NULL,
        envelope_version integer NOT NULL,
        config_version integer NOT NULL,
        key_id varchar(48) NOT NULL,
        nonce bytea NOT NULL,
        ciphertext bytea NOT NULL,
        auth_tag bytea NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (payment_attempt_id, envelope_version),
        CONSTRAINT payment_attempt_secrets_attempt_fkey
          FOREIGN KEY (payment_attempt_id) REFERENCES payment_attempts (id) ON DELETE RESTRICT,
        CONSTRAINT payment_attempt_secrets_version_check CHECK (envelope_version > 0 AND config_version > 0),
        CONSTRAINT payment_attempt_secrets_key_id_check CHECK (btrim(key_id) <> ''),
        CONSTRAINT payment_attempt_secrets_nonce_check CHECK (octet_length(nonce) = 12),
        CONSTRAINT payment_attempt_secrets_tag_check CHECK (octet_length(auth_tag) = 16)
      )
    `.execute(db)
    await sql`CREATE TRIGGER payment_attempt_secrets_immutable BEFORE UPDATE OR DELETE ON payment_attempt_secrets FOR EACH ROW EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)
    await sql`CREATE TRIGGER payment_attempt_secrets_prevent_truncate BEFORE TRUNCATE ON payment_attempt_secrets FOR EACH STATEMENT EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)

    await sql`
      CREATE TABLE payment_attempt_provider_state (
        payment_attempt_id uuid PRIMARY KEY,
        state varchar(24) NOT NULL,
        action jsonb,
        provider_order_id varchar(200),
        last_error_code varchar(64),
        request_started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        last_query_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT payment_attempt_provider_state_attempt_fkey
          FOREIGN KEY (payment_attempt_id) REFERENCES payment_attempts (id) ON DELETE RESTRICT,
        CONSTRAINT payment_attempt_provider_state_check
          CHECK (state IN ('requesting', 'ready', 'unknown', 'failed')),
        CONSTRAINT payment_attempt_provider_action_check
          CHECK (action IS NULL OR jsonb_typeof(action) = 'object'),
        CONSTRAINT payment_attempt_provider_ready_check
          CHECK (state <> 'ready' OR action IS NOT NULL)
      )
    `.execute(db)
    await sql`
      CREATE FUNCTION protect_payment_attempt_provider_state() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.payment_attempt_id IS DISTINCT FROM NEW.payment_attempt_id
          OR OLD.request_started_at IS DISTINCT FROM NEW.request_started_at THEN
          RAISE EXCEPTION 'Payment provider request identity is immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_attempt_provider_state_immutable';
        END IF;
        IF OLD.action IS NOT NULL AND OLD.action IS DISTINCT FROM NEW.action THEN
          RAISE EXCEPTION 'A payment action cannot be replaced after it is saved'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_attempt_provider_action_immutable';
        END IF;
        IF OLD.provider_order_id IS NOT NULL AND OLD.provider_order_id IS DISTINCT FROM NEW.provider_order_id THEN
          RAISE EXCEPTION 'A provider order identity cannot be replaced'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_attempt_provider_order_immutable';
        END IF;
        IF OLD.state IS DISTINCT FROM NEW.state AND NOT (
          (OLD.state = 'requesting' AND NEW.state IN ('ready', 'unknown', 'failed'))
          OR (OLD.state = 'unknown' AND NEW.state IN ('ready', 'failed'))
        ) THEN
          RAISE EXCEPTION 'Illegal provider request state transition: % to %', OLD.state, NEW.state
            USING ERRCODE = '23514', CONSTRAINT = 'payment_attempt_provider_state_transition';
        END IF;
        NEW.updated_at := clock_timestamp();
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER payment_attempt_provider_state_guard BEFORE UPDATE ON payment_attempt_provider_state FOR EACH ROW EXECUTE FUNCTION protect_payment_attempt_provider_state()`.execute(db)

    await sql`
      CREATE TABLE payment_provider_events (
        id uuid PRIMARY KEY,
        payment_attempt_id uuid NOT NULL,
        source varchar(16) NOT NULL,
        event_sha256 char(64) NOT NULL,
        verification varchar(24) NOT NULL,
        disposition varchar(32) NOT NULL,
        provider_status varchar(24) NOT NULL,
        provider_transaction_id varchar(200),
        reported_amount numeric(18, 2),
        currency varchar(3) NOT NULL DEFAULT 'CNY',
        provider_paid_at timestamptz,
        provider_time_text varchar(64),
        payload jsonb NOT NULL,
        error_code varchar(64),
        received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT payment_provider_events_attempt_fkey
          FOREIGN KEY (payment_attempt_id) REFERENCES payment_attempts (id) ON DELETE RESTRICT,
        CONSTRAINT payment_provider_events_source_check CHECK (source IN ('callback', 'query')),
        CONSTRAINT payment_provider_events_hash_check CHECK (event_sha256 ~ '^[0-9a-f]{64}$'),
        CONSTRAINT payment_provider_events_verification_check CHECK (verification IN ('verified', 'unverified')),
        CONSTRAINT payment_provider_events_disposition_check
          CHECK (disposition IN ('settled', 'duplicate', 'not_paid', 'pending_confirmation', 'reconciliation_required', 'unknown')),
        CONSTRAINT payment_provider_events_status_check CHECK (provider_status IN ('paid', 'pending', 'failed', 'unknown')),
        CONSTRAINT payment_provider_events_amount_check CHECK (reported_amount IS NULL OR reported_amount > 0),
        CONSTRAINT payment_provider_events_currency_check CHECK (currency = 'CNY'),
        CONSTRAINT payment_provider_events_payload_check CHECK (jsonb_typeof(payload) = 'object'),
        CONSTRAINT payment_provider_events_unique UNIQUE (payment_attempt_id, source, event_sha256)
      )
    `.execute(db)
    await sql`CREATE INDEX payment_provider_events_reconciliation_idx ON payment_provider_events (received_at, payment_attempt_id) WHERE disposition = 'reconciliation_required'`.execute(db)
    await sql`
      CREATE FUNCTION protect_payment_provider_event() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'Payment provider events are immutable evidence'
          USING ERRCODE = '23514', CONSTRAINT = 'payment_provider_events_immutable';
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER payment_provider_events_immutable BEFORE UPDATE OR DELETE ON payment_provider_events FOR EACH ROW EXECUTE FUNCTION protect_payment_provider_event()`.execute(db)
    await sql`CREATE TRIGGER payment_provider_events_prevent_truncate BEFORE TRUNCATE ON payment_provider_events FOR EACH STATEMENT EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)

    // R1 intentionally keeps expired attempts intact when an order closes, so
    // a provider can still deliver a late receipt. The frozen ④-1 transition
    // table omitted created -> late_succeeded even though its receipt trigger
    // performs that transition after classifying a late receipt. Permit the
    // transition only with the same immutable late-receipt evidence check.
    await sql`
      CREATE OR REPLACE FUNCTION guard_payment_attempt_update() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF ROW(NEW.id, NEW.idempotency_key, NEW.request_sha256, NEW.order_id, NEW.topup_customer_id,
               NEW.source, NEW.amount, NEW.provider, NEW.provider_payment_id, NEW.wallet_operation_id,
               NEW.wallet_hold_operation_id, NEW.requested_wallet_amount, NEW.created_at)
          IS DISTINCT FROM ROW(OLD.id, OLD.idempotency_key, OLD.request_sha256, OLD.order_id, OLD.topup_customer_id,
               OLD.source, OLD.amount, OLD.provider, OLD.provider_payment_id, OLD.wallet_operation_id,
               OLD.wallet_hold_operation_id, OLD.requested_wallet_amount, OLD.created_at) THEN
          RAISE EXCEPTION 'Payment attempt identity, source and expected amount are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_attempts_identity_immutable';
        END IF;
        IF OLD.status IS DISTINCT FROM NEW.status AND NOT (
          (OLD.status = 'created' AND NEW.status IN ('pending', 'succeeded', 'failed', 'expired', 'cancelled', 'late_succeeded', 'reconciliation_required'))
          OR (OLD.status = 'pending' AND NEW.status IN ('succeeded', 'failed', 'expired', 'cancelled', 'late_succeeded', 'reconciliation_required'))
          OR (OLD.status IN ('failed', 'expired', 'cancelled') AND NEW.status IN ('late_succeeded', 'reconciliation_required'))
          OR (OLD.status = 'reconciliation_required' AND NEW.status IN ('succeeded', 'late_succeeded'))
        ) THEN
          RAISE EXCEPTION 'Illegal payment attempt transition: % to %', OLD.status, NEW.status
            USING ERRCODE = '23514', CONSTRAINT = 'payment_attempts_status_transition';
        END IF;
        IF NEW.status = 'succeeded' AND NOT EXISTS (
          SELECT 1 FROM payment_receipts AS receipt WHERE receipt.payment_attempt_id = NEW.id
          GROUP BY receipt.payment_attempt_id
          HAVING bool_and(receipt.disposition = 'on_time') AND (
            (NEW.source = 'wallet' AND sum(receipt.amount) = NEW.amount)
            OR (NEW.source = 'external' AND sum(receipt.amount) FILTER (WHERE receipt.source_bucket = 'external') = NEW.amount
              AND count(*) FILTER (WHERE receipt.source_bucket = 'external') = 1)
          )
        ) THEN
          RAISE EXCEPTION 'A successful payment attempt requires matching on-time receipt evidence'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_attempts_success_requires_receipt';
        END IF;
        IF NEW.status = 'late_succeeded' AND NOT EXISTS (
          SELECT 1 FROM payment_receipts AS receipt
          WHERE receipt.payment_attempt_id = NEW.id AND receipt.disposition = 'late'
        ) THEN
          RAISE EXCEPTION 'A late payment attempt requires late receipt evidence'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_attempts_late_requires_receipt';
        END IF;
        IF NEW.status = 'reconciliation_required' AND NOT EXISTS (
          SELECT 1 FROM payment_receipts AS receipt
          WHERE receipt.payment_attempt_id = NEW.id AND receipt.disposition IN ('amount_mismatch', 'excess')
        ) THEN
          RAISE EXCEPTION 'Payment reconciliation requires a mismatched or excess receipt'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_attempts_reconciliation_requires_receipt';
        END IF;
        IF OLD.status IS NOT DISTINCT FROM NEW.status THEN
          IF NEW.completed_at IS DISTINCT FROM OLD.completed_at THEN
            RAISE EXCEPTION 'Payment completion time is controlled by its state transition'
              USING ERRCODE = '23514', CONSTRAINT = 'payment_attempts_completed_at_guard';
          END IF;
        ELSE
          NEW.completed_at := CASE
            WHEN NEW.status IN ('created', 'pending') THEN NULL
            ELSE now()
          END;
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
  },
}
