import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

export const tradeFoundationMigration: Migration = {
  async up(db) {
    await sql`
      CREATE TABLE storefront_customer_policy (
        singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
        require_email boolean NOT NULL DEFAULT false,
        require_phone boolean NOT NULL DEFAULT false,
        guest_checkout_enabled boolean NOT NULL DEFAULT false,
        guest_free_claim_enabled boolean NOT NULL DEFAULT false,
        unpaid_order_timeout_minutes integer NOT NULL DEFAULT 15,
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT storefront_customer_policy_timeout_check
          CHECK (unpaid_order_timeout_minutes BETWEEN 1 AND 10080)
      )
    `.execute(db)
    await sql`INSERT INTO storefront_customer_policy (singleton) VALUES (true)`.execute(db)

    await sql`
      CREATE TABLE customers (
        id uuid PRIMARY KEY,
        username varchar(64),
        password_hash text,
        email varchar(254),
        email_verified_at timestamptz,
        phone varchar(32),
        phone_verified_at timestamptz,
        status varchar(16) NOT NULL DEFAULT 'active',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT customers_status_check CHECK (status IN ('active', 'disabled', 'deleted')),
        CONSTRAINT customers_identity_state_check CHECK (
          (status IN ('active', 'disabled') AND username IS NOT NULL AND btrim(username) <> ''
            AND password_hash IS NOT NULL AND btrim(password_hash) <> '')
          OR (status = 'deleted' AND username IS NULL AND password_hash IS NULL
            AND email IS NULL AND email_verified_at IS NULL
            AND phone IS NULL AND phone_verified_at IS NULL)
        ),
        CONSTRAINT customers_email_check CHECK (email IS NULL OR (btrim(email) <> '' AND email = btrim(email))),
        CONSTRAINT customers_phone_check CHECK (phone IS NULL OR (btrim(phone) <> '' AND phone = btrim(phone))),
        CONSTRAINT customers_email_verified_check CHECK (email_verified_at IS NULL OR email IS NOT NULL),
        CONSTRAINT customers_phone_verified_check CHECK (phone_verified_at IS NULL OR phone IS NOT NULL)
      )
    `.execute(db)
    await sql`CREATE UNIQUE INDEX customers_username_lower_unique ON customers (lower(username)) WHERE username IS NOT NULL`.execute(db)
    await sql`CREATE UNIQUE INDEX customers_email_lower_unique ON customers (lower(email)) WHERE email IS NOT NULL`.execute(db)
    await sql`CREATE UNIQUE INDEX customers_phone_unique ON customers (phone) WHERE phone IS NOT NULL`.execute(db)

    await sql`
      CREATE TABLE guest_order_sessions (
        id uuid PRIMARY KEY,
        token_hash char(64) NOT NULL UNIQUE,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL,
        revoked_at timestamptz,
        CONSTRAINT guest_order_sessions_token_hash_check CHECK (token_hash ~ '^[0-9a-f]{64}$'),
        CONSTRAINT guest_order_sessions_expiration_check CHECK (expires_at > created_at)
      )
    `.execute(db)
    await sql`CREATE INDEX guest_order_sessions_expiry_idx ON guest_order_sessions (expires_at) WHERE revoked_at IS NULL`.execute(db)

    await sql`
      CREATE TABLE product_variant_fulfillment (
        product_variant_id uuid PRIMARY KEY,
        method varchar(24) NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT product_variant_fulfillment_variant_fkey
          FOREIGN KEY (product_variant_id) REFERENCES product_variants (id) ON DELETE CASCADE,
        CONSTRAINT product_variant_fulfillment_method_check
          CHECK (method IN ('manual', 'code_pool', 'fixed_content', 'link', 'file', 'api'))
      )
    `.execute(db)

    await sql`
      CREATE TABLE orders (
        id uuid PRIMARY KEY,
        customer_id uuid,
        guest_order_session_id uuid,
        idempotency_key uuid NOT NULL,
        request_sha256 char(64) NOT NULL,
        status varchar(24) NOT NULL DEFAULT 'pending_payment',
        total_amount numeric(18, 2) NOT NULL,
        currency char(3) NOT NULL DEFAULT 'CNY',
        created_at timestamptz NOT NULL DEFAULT now(),
        unpaid_expires_at timestamptz,
        history_hidden_at timestamptz,
        history_hidden_by_admin_id uuid,
        history_hidden_reason varchar(500),
        CONSTRAINT orders_customer_fkey FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE RESTRICT,
        CONSTRAINT orders_guest_session_fkey FOREIGN KEY (guest_order_session_id) REFERENCES guest_order_sessions (id) ON DELETE RESTRICT,
        CONSTRAINT orders_history_hidden_admin_fkey FOREIGN KEY (history_hidden_by_admin_id) REFERENCES admin_users (id) ON DELETE RESTRICT,
        CONSTRAINT orders_single_owner_check CHECK (num_nonnulls(customer_id, guest_order_session_id) = 1),
        CONSTRAINT orders_idempotency_hash_check CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
        CONSTRAINT orders_status_check CHECK (status IN ('pending_payment', 'processing', 'completed', 'closed')),
        CONSTRAINT orders_amount_check CHECK (total_amount >= 0),
        CONSTRAINT orders_currency_check CHECK (currency = 'CNY'),
        CONSTRAINT orders_timeout_check CHECK (
          (total_amount = 0 AND unpaid_expires_at IS NULL)
          OR (total_amount > 0 AND unpaid_expires_at IS NOT NULL)
        ),
        CONSTRAINT orders_history_hidden_check CHECK (
          (history_hidden_at IS NULL AND history_hidden_by_admin_id IS NULL AND history_hidden_reason IS NULL)
          OR (history_hidden_at IS NOT NULL AND history_hidden_by_admin_id IS NOT NULL
            AND history_hidden_reason IS NOT NULL AND btrim(history_hidden_reason) <> '')
        )
      )
    `.execute(db)
    await sql`CREATE UNIQUE INDEX orders_customer_idempotency_unique ON orders (customer_id, idempotency_key) WHERE customer_id IS NOT NULL`.execute(db)
    await sql`CREATE UNIQUE INDEX orders_guest_idempotency_unique ON orders (guest_order_session_id, idempotency_key) WHERE guest_order_session_id IS NOT NULL`.execute(db)
    await sql`CREATE INDEX orders_customer_created_idx ON orders (customer_id, created_at DESC, id DESC) WHERE customer_id IS NOT NULL`.execute(db)
    await sql`CREATE INDEX orders_guest_created_idx ON orders (guest_order_session_id, created_at DESC, id DESC) WHERE guest_order_session_id IS NOT NULL`.execute(db)
    await sql`CREATE INDEX orders_status_expiry_idx ON orders (unpaid_expires_at, id) WHERE status = 'pending_payment'`.execute(db)

    await sql`
      CREATE TABLE order_items (
        id uuid PRIMARY KEY,
        order_id uuid NOT NULL,
        product_id uuid NOT NULL,
        product_variant_id uuid NOT NULL,
        product_name_snapshot varchar(200) NOT NULL,
        product_type_snapshot varchar(16) NOT NULL,
        sku_code_snapshot varchar(64) NOT NULL,
        sku_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
        inventory_mode_snapshot varchar(16) NOT NULL,
        fulfillment_method_snapshot varchar(24) NOT NULL,
        unit_price numeric(18, 2) NOT NULL,
        quantity integer NOT NULL,
        line_amount numeric(18, 2) NOT NULL,
        fulfillment_status varchar(24) NOT NULL DEFAULT 'pending',
        fulfilled_quantity integer NOT NULL DEFAULT 0,
        fulfillment_reserved_quantity integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT order_items_order_fkey FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE RESTRICT,
        CONSTRAINT order_items_product_fkey FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE RESTRICT,
        CONSTRAINT order_items_variant_fkey FOREIGN KEY (product_id, product_variant_id)
          REFERENCES product_variants (product_id, id) ON DELETE RESTRICT,
        CONSTRAINT order_items_product_sku_unique UNIQUE (order_id, product_variant_id),
        CONSTRAINT order_items_id_product_variant_unique UNIQUE (id, product_id, product_variant_id),
        CONSTRAINT order_items_product_name_check CHECK (btrim(product_name_snapshot) <> ''),
        CONSTRAINT order_items_product_type_check CHECK (product_type_snapshot IN ('physical', 'digital', 'service')),
        CONSTRAINT order_items_sku_code_check CHECK (btrim(sku_code_snapshot) <> ''),
        CONSTRAINT order_items_sku_snapshot_check CHECK (jsonb_typeof(sku_snapshot) = 'array'),
        CONSTRAINT order_items_inventory_mode_check CHECK (inventory_mode_snapshot IN ('quantity', 'unlimited')),
        CONSTRAINT order_items_fulfillment_method_check CHECK (
          fulfillment_method_snapshot IN ('manual', 'code_pool', 'fixed_content', 'link', 'file', 'api')
        ),
        CONSTRAINT order_items_quantity_check CHECK (quantity > 0),
        CONSTRAINT order_items_amount_check CHECK (unit_price >= 0 AND line_amount >= 0 AND line_amount = unit_price * quantity),
        CONSTRAINT order_items_fulfillment_status_check CHECK (
          fulfillment_status IN ('pending', 'processing', 'partially_fulfilled', 'failed', 'unknown', 'completed')
        ),
        CONSTRAINT order_items_fulfilled_quantity_check CHECK (
          fulfilled_quantity >= 0 AND fulfillment_reserved_quantity >= 0
          AND fulfilled_quantity + fulfillment_reserved_quantity <= quantity
          AND (fulfillment_status <> 'completed' OR fulfilled_quantity = quantity)
        )
      )
    `.execute(db)
    await sql`CREATE INDEX order_items_product_sku_idx ON order_items (product_id, product_variant_id)`.execute(db)

    await sql`
      CREATE TABLE order_inventory_reservations (
        id uuid PRIMARY KEY,
        order_item_id uuid NOT NULL UNIQUE,
        product_id uuid NOT NULL,
        product_variant_id uuid NOT NULL,
        quantity integer NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT order_inventory_reservations_item_fkey
          FOREIGN KEY (order_item_id, product_id, product_variant_id)
          REFERENCES order_items (id, product_id, product_variant_id) ON DELETE RESTRICT,
        CONSTRAINT order_inventory_reservations_quantity_check CHECK (quantity > 0)
      )
    `.execute(db)
    await sql`CREATE INDEX order_inventory_reservations_variant_idx ON order_inventory_reservations (product_variant_id, order_item_id)`.execute(db)

    await sql`
      CREATE TABLE order_inventory_events (
        id uuid PRIMARY KEY,
        reservation_id uuid NOT NULL,
        operation_id uuid NOT NULL UNIQUE,
        action varchar(16) NOT NULL,
        quantity integer NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT order_inventory_events_reservation_fkey
          FOREIGN KEY (reservation_id) REFERENCES order_inventory_reservations (id) ON DELETE RESTRICT,
        CONSTRAINT order_inventory_events_action_check CHECK (action IN ('reserve', 'release', 'consume')),
        CONSTRAINT order_inventory_events_quantity_check CHECK (quantity > 0)
      )
    `.execute(db)
    await sql`CREATE UNIQUE INDEX order_inventory_events_one_reserve_unique ON order_inventory_events (reservation_id) WHERE action = 'reserve'`.execute(db)
    await sql`CREATE INDEX order_inventory_events_reservation_created_idx ON order_inventory_events (reservation_id, created_at, id)`.execute(db)

    await sql`
      CREATE TABLE wallet_accounts (
        customer_id uuid PRIMARY KEY,
        cash_available numeric(18, 2) NOT NULL DEFAULT 0,
        cash_frozen numeric(18, 2) NOT NULL DEFAULT 0,
        gift_available numeric(18, 2) NOT NULL DEFAULT 0,
        gift_frozen numeric(18, 2) NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT wallet_accounts_customer_fkey FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE RESTRICT,
        CONSTRAINT wallet_accounts_nonnegative_check CHECK (
          cash_available >= 0 AND cash_frozen >= 0 AND gift_available >= 0 AND gift_frozen >= 0
        )
      )
    `.execute(db)

    await sql`
      CREATE TABLE wallet_operations (
        id uuid PRIMARY KEY,
        customer_id uuid NOT NULL,
        operation_type varchar(24) NOT NULL,
        request_sha256 char(64) NOT NULL,
        actor_admin_id uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT wallet_operations_customer_fkey FOREIGN KEY (customer_id) REFERENCES wallet_accounts (customer_id) ON DELETE RESTRICT,
        CONSTRAINT wallet_operations_actor_admin_fkey FOREIGN KEY (actor_admin_id) REFERENCES admin_users (id) ON DELETE RESTRICT,
        CONSTRAINT wallet_operations_customer_id_unique UNIQUE (customer_id, id),
        CONSTRAINT wallet_operations_type_check CHECK (operation_type IN (
          'top_up', 'order_payment', 'refund', 'gift', 'withdrawal_freeze',
          'withdrawal_release', 'withdrawal_complete', 'adjustment'
        )),
        CONSTRAINT wallet_operations_hash_check CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
        CONSTRAINT wallet_operations_admin_actor_check CHECK (
          (operation_type IN ('gift', 'adjustment') AND actor_admin_id IS NOT NULL)
          OR (operation_type NOT IN ('gift', 'adjustment') AND actor_admin_id IS NULL)
        )
      )
    `.execute(db)

    await sql`
      CREATE TABLE payment_attempts (
        id uuid PRIMARY KEY,
        idempotency_key uuid NOT NULL UNIQUE,
        request_sha256 char(64) NOT NULL,
        order_id uuid,
        topup_customer_id uuid,
        source varchar(16) NOT NULL,
        amount numeric(18, 2) NOT NULL,
        status varchar(32) NOT NULL DEFAULT 'created',
        provider varchar(64),
        provider_payment_id varchar(200),
        wallet_operation_id uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz,
        completed_at timestamptz,
        CONSTRAINT payment_attempts_order_fkey FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE RESTRICT,
        CONSTRAINT payment_attempts_topup_customer_fkey FOREIGN KEY (topup_customer_id) REFERENCES customers (id) ON DELETE RESTRICT,
        CONSTRAINT payment_attempts_wallet_operation_fkey FOREIGN KEY (wallet_operation_id) REFERENCES wallet_operations (id) ON DELETE RESTRICT,
        CONSTRAINT payment_attempts_single_target_check CHECK (num_nonnulls(order_id, topup_customer_id) = 1),
        CONSTRAINT payment_attempts_source_check CHECK (source IN ('external', 'wallet')),
        CONSTRAINT payment_attempts_amount_check CHECK (amount > 0),
        CONSTRAINT payment_attempts_status_check CHECK (status IN (
          'created', 'pending', 'succeeded', 'failed', 'expired', 'cancelled',
          'late_succeeded', 'reconciliation_required'
        )),
        CONSTRAINT payment_attempts_completed_at_check CHECK (
          (status IN ('created', 'pending') AND completed_at IS NULL)
          OR (status NOT IN ('created', 'pending') AND completed_at IS NOT NULL)
        ),
        CONSTRAINT payment_attempts_hash_check CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
        CONSTRAINT payment_attempts_source_target_check CHECK (
          (source = 'external' AND provider IS NOT NULL AND btrim(provider) <> ''
            AND wallet_operation_id IS NULL)
          OR (source = 'wallet' AND order_id IS NOT NULL
            AND topup_customer_id IS NULL AND provider IS NULL AND provider_payment_id IS NULL
            AND wallet_operation_id IS NOT NULL)
        ),
        CONSTRAINT payment_attempts_provider_id_check CHECK (
          provider_payment_id IS NULL OR (source = 'external' AND btrim(provider_payment_id) <> '')
        ),
        CONSTRAINT payment_attempts_expiration_check CHECK (expires_at IS NULL OR expires_at > created_at)
      )
    `.execute(db)
    await sql`CREATE UNIQUE INDEX payment_attempts_provider_payment_unique ON payment_attempts (provider, provider_payment_id) WHERE provider_payment_id IS NOT NULL`.execute(db)
    await sql`CREATE INDEX payment_attempts_order_created_idx ON payment_attempts (order_id, created_at DESC, id DESC) WHERE order_id IS NOT NULL`.execute(db)
    await sql`CREATE INDEX payment_attempts_topup_created_idx ON payment_attempts (topup_customer_id, created_at DESC, id DESC) WHERE topup_customer_id IS NOT NULL`.execute(db)

    await sql`
      CREATE TABLE payment_receipts (
        id uuid PRIMARY KEY,
        payment_attempt_id uuid NOT NULL,
        source_bucket varchar(16) NOT NULL,
        provider varchar(64),
        provider_transaction_id varchar(200),
        wallet_operation_id uuid,
        wallet_line_no smallint,
        amount numeric(18, 2) NOT NULL,
        disposition varchar(24) NOT NULL DEFAULT 'on_time',
        refund_reserved_amount numeric(18, 2) NOT NULL DEFAULT 0,
        refunded_amount numeric(18, 2) NOT NULL DEFAULT 0,
        received_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT payment_receipts_attempt_fkey FOREIGN KEY (payment_attempt_id) REFERENCES payment_attempts (id) ON DELETE RESTRICT,
        CONSTRAINT payment_receipts_attempt_bucket_unique UNIQUE (payment_attempt_id, source_bucket),
        CONSTRAINT payment_receipts_amount_check CHECK (amount > 0),
        CONSTRAINT payment_receipts_bucket_check CHECK (source_bucket IN ('external', 'cash', 'gift')),
        CONSTRAINT payment_receipts_disposition_check CHECK (disposition IN ('on_time', 'late', 'excess', 'amount_mismatch')),
        CONSTRAINT payment_receipts_refund_amount_check CHECK (
          refund_reserved_amount >= 0 AND refunded_amount >= 0
          AND refund_reserved_amount + refunded_amount <= amount
        ),
        CONSTRAINT payment_receipts_source_reference_check CHECK (
          (source_bucket = 'external' AND provider IS NOT NULL AND btrim(provider) <> ''
            AND provider_transaction_id IS NOT NULL AND btrim(provider_transaction_id) <> ''
            AND wallet_operation_id IS NULL AND wallet_line_no IS NULL)
          OR (source_bucket IN ('cash', 'gift') AND provider IS NULL AND provider_transaction_id IS NULL
            AND wallet_operation_id IS NOT NULL AND wallet_line_no BETWEEN 1 AND 2)
        )
      )
    `.execute(db)
    await sql`CREATE UNIQUE INDEX payment_receipts_provider_transaction_unique ON payment_receipts (provider, provider_transaction_id) WHERE provider_transaction_id IS NOT NULL`.execute(db)
    await sql`CREATE UNIQUE INDEX payment_receipts_wallet_operation_line_unique ON payment_receipts (wallet_operation_id, wallet_line_no) WHERE wallet_operation_id IS NOT NULL`.execute(db)
    await sql`CREATE INDEX payment_receipts_attempt_received_idx ON payment_receipts (payment_attempt_id, received_at, id)`.execute(db)

    await sql`
      CREATE TABLE order_refunds (
        id uuid PRIMARY KEY,
        order_id uuid NOT NULL,
        idempotency_key uuid NOT NULL,
        request_sha256 char(64) NOT NULL,
        amount numeric(18, 2) NOT NULL,
        status varchar(24) NOT NULL DEFAULT 'requested',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT order_refunds_order_fkey FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE RESTRICT,
        CONSTRAINT order_refunds_order_idempotency_unique UNIQUE (order_id, idempotency_key),
        CONSTRAINT order_refunds_amount_check CHECK (amount > 0),
        CONSTRAINT order_refunds_hash_check CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
        CONSTRAINT order_refunds_status_check CHECK (status IN (
          'requested', 'approved', 'processing', 'partially_succeeded',
          'succeeded', 'failed', 'cancelled'
        ))
      )
    `.execute(db)
    await sql`CREATE INDEX order_refunds_order_created_idx ON order_refunds (order_id, created_at DESC, id DESC)`.execute(db)

    await sql`
      CREATE TABLE order_refund_allocations (
        id uuid PRIMARY KEY,
        refund_id uuid NOT NULL,
        source_payment_receipt_id uuid NOT NULL,
        operation_id uuid NOT NULL UNIQUE,
        request_sha256 char(64) NOT NULL,
        destination varchar(24) NOT NULL,
        amount numeric(18, 2) NOT NULL,
        status varchar(16) NOT NULL DEFAULT 'reserved',
        provider varchar(64),
        provider_refund_id varchar(200),
        created_at timestamptz NOT NULL DEFAULT now(),
        completed_at timestamptz,
        CONSTRAINT order_refund_allocations_refund_fkey FOREIGN KEY (refund_id) REFERENCES order_refunds (id) ON DELETE RESTRICT,
        CONSTRAINT order_refund_allocations_source_fkey FOREIGN KEY (source_payment_receipt_id) REFERENCES payment_receipts (id) ON DELETE RESTRICT,
        CONSTRAINT order_refund_allocations_amount_check CHECK (amount > 0),
        CONSTRAINT order_refund_allocations_hash_check CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
        CONSTRAINT order_refund_allocations_destination_check CHECK (destination IN ('original_source', 'cash_balance', 'gift_balance')),
        CONSTRAINT order_refund_allocations_status_check CHECK (status IN ('reserved', 'succeeded', 'released')),
        CONSTRAINT order_refund_allocations_provider_check CHECK (
          (destination = 'original_source' AND (
            (status = 'succeeded' AND provider IS NOT NULL AND provider_refund_id IS NOT NULL)
            OR (status <> 'succeeded' AND provider_refund_id IS NULL)
          ))
          OR (destination <> 'original_source' AND provider IS NULL AND provider_refund_id IS NULL)
        )
      )
    `.execute(db)
    await sql`CREATE INDEX order_refund_allocations_refund_idx ON order_refund_allocations (refund_id, id)`.execute(db)
    await sql`CREATE UNIQUE INDEX order_refund_allocations_provider_refund_unique ON order_refund_allocations (provider, provider_refund_id) WHERE provider_refund_id IS NOT NULL`.execute(db)

    await sql`
      CREATE TABLE wallet_ledger_entries (
        id uuid PRIMARY KEY,
        wallet_operation_id uuid NOT NULL,
        line_no smallint NOT NULL,
        customer_id uuid NOT NULL,
        bucket varchar(8) NOT NULL,
        action varchar(24) NOT NULL,
        amount numeric(18, 2) NOT NULL,
        payment_attempt_id uuid,
        refund_allocation_id uuid,
        withdrawal_id uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT wallet_ledger_entries_operation_fkey FOREIGN KEY (customer_id, wallet_operation_id)
          REFERENCES wallet_operations (customer_id, id) ON DELETE RESTRICT,
        CONSTRAINT wallet_ledger_entries_payment_fkey FOREIGN KEY (payment_attempt_id) REFERENCES payment_attempts (id) ON DELETE RESTRICT,
        CONSTRAINT wallet_ledger_entries_operation_line_unique UNIQUE (wallet_operation_id, line_no),
        CONSTRAINT wallet_ledger_entries_source_check CHECK (num_nonnulls(payment_attempt_id, refund_allocation_id, withdrawal_id) <= 1),
        CONSTRAINT wallet_ledger_entries_bucket_check CHECK (bucket IN ('cash', 'gift')),
        CONSTRAINT wallet_ledger_entries_action_check CHECK (action IN (
          'credit_available', 'debit_available', 'freeze', 'unfreeze', 'debit_frozen'
        )),
        CONSTRAINT wallet_ledger_entries_amount_check CHECK (line_no > 0 AND amount > 0)
      )
    `.execute(db)
    await sql`CREATE INDEX wallet_ledger_entries_customer_created_idx ON wallet_ledger_entries (customer_id, created_at DESC, id DESC)`.execute(db)
    await sql`CREATE INDEX wallet_ledger_entries_source_payment_idx ON wallet_ledger_entries (payment_attempt_id) WHERE payment_attempt_id IS NOT NULL`.execute(db)
    await sql`CREATE UNIQUE INDEX wallet_ledger_entries_payment_attempt_bucket_unique ON wallet_ledger_entries (payment_attempt_id, bucket) WHERE payment_attempt_id IS NOT NULL`.execute(db)
    await sql`CREATE UNIQUE INDEX wallet_ledger_entries_refund_allocation_unique ON wallet_ledger_entries (refund_allocation_id) WHERE refund_allocation_id IS NOT NULL`.execute(db)
    await sql`CREATE UNIQUE INDEX wallet_ledger_entries_withdrawal_action_unique ON wallet_ledger_entries (withdrawal_id, action) WHERE withdrawal_id IS NOT NULL`.execute(db)

    await sql`
      CREATE TABLE withdrawals (
        id uuid PRIMARY KEY,
        customer_id uuid NOT NULL,
        idempotency_key uuid NOT NULL,
        request_sha256 char(64) NOT NULL,
        wallet_operation_id uuid NOT NULL UNIQUE,
        amount numeric(18, 2) NOT NULL,
        fee_amount numeric(18, 2) NOT NULL,
        payout_amount numeric(18, 2) NOT NULL,
        payout_method varchar(24) NOT NULL,
        recipient_snapshot jsonb NOT NULL,
        status varchar(32) NOT NULL DEFAULT 'pending_review',
        reviewed_by_admin_id uuid,
        reviewed_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT withdrawals_customer_fkey FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE RESTRICT,
        CONSTRAINT withdrawals_wallet_operation_fkey FOREIGN KEY (customer_id, wallet_operation_id) REFERENCES wallet_operations (customer_id, id) ON DELETE RESTRICT,
        CONSTRAINT withdrawals_review_admin_fkey FOREIGN KEY (reviewed_by_admin_id) REFERENCES admin_users (id) ON DELETE RESTRICT,
        CONSTRAINT withdrawals_customer_idempotency_unique UNIQUE (customer_id, idempotency_key),
        CONSTRAINT withdrawals_hash_check CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
        CONSTRAINT withdrawals_amount_check CHECK (amount > 0 AND fee_amount >= 0 AND fee_amount <= amount AND payout_amount = amount - fee_amount),
        CONSTRAINT withdrawals_method_check CHECK (payout_method IN ('alipay', 'wechat', 'bank_card')),
        CONSTRAINT withdrawals_recipient_check CHECK (jsonb_typeof(recipient_snapshot) = 'object'),
        CONSTRAINT withdrawals_status_check CHECK (status IN (
          'pending_review', 'pending_transfer', 'transfer_processing',
          'transfer_uncertain', 'completed', 'rejected', 'cancelled'
        )),
        CONSTRAINT withdrawals_review_state_check CHECK (
          (reviewed_by_admin_id IS NULL AND reviewed_at IS NULL)
          OR (reviewed_by_admin_id IS NOT NULL AND reviewed_at IS NOT NULL)
        )
      )
    `.execute(db)
    await sql`CREATE INDEX withdrawals_customer_created_idx ON withdrawals (customer_id, created_at DESC, id DESC)`.execute(db)
    await sql`CREATE INDEX withdrawals_status_created_idx ON withdrawals (status, created_at, id)`.execute(db)

    await sql`
      CREATE TABLE withdrawal_payout_attempts (
        id uuid PRIMARY KEY,
        withdrawal_id uuid NOT NULL,
        operation_id uuid NOT NULL UNIQUE,
        started_by_admin_id uuid NOT NULL,
        resolved_by_admin_id uuid,
        result_sha256 char(64),
        status varchar(16) NOT NULL DEFAULT 'started',
        provider_reference varchar(200),
        created_at timestamptz NOT NULL DEFAULT now(),
        completed_at timestamptz,
        CONSTRAINT withdrawal_payout_attempts_withdrawal_fkey FOREIGN KEY (withdrawal_id) REFERENCES withdrawals (id) ON DELETE RESTRICT,
        CONSTRAINT withdrawal_payout_attempts_admin_fkey FOREIGN KEY (started_by_admin_id) REFERENCES admin_users (id) ON DELETE RESTRICT,
        CONSTRAINT withdrawal_payout_attempts_resolver_fkey FOREIGN KEY (resolved_by_admin_id) REFERENCES admin_users (id) ON DELETE RESTRICT,
        CONSTRAINT withdrawal_payout_attempts_status_check CHECK (status IN ('started', 'unknown', 'succeeded', 'failed')),
        CONSTRAINT withdrawal_payout_attempts_completed_at_check CHECK (
          (status = 'started' AND completed_at IS NULL)
          OR (status <> 'started' AND completed_at IS NOT NULL)
        ),
        CONSTRAINT withdrawal_payout_attempts_result_check CHECK (
          (status IN ('started', 'unknown') AND resolved_by_admin_id IS NULL AND result_sha256 IS NULL)
          OR (status IN ('succeeded', 'failed') AND resolved_by_admin_id IS NOT NULL
            AND result_sha256 IS NOT NULL AND result_sha256 ~ '^[0-9a-f]{64}$')
        ),
        CONSTRAINT withdrawal_payout_attempts_reference_check CHECK (provider_reference IS NULL OR btrim(provider_reference) <> '')
      )
    `.execute(db)
    await sql`CREATE UNIQUE INDEX withdrawal_payout_attempts_reference_unique ON withdrawal_payout_attempts (provider_reference) WHERE provider_reference IS NOT NULL`.execute(db)
    await sql`CREATE UNIQUE INDEX withdrawal_payout_attempts_active_unique ON withdrawal_payout_attempts (withdrawal_id) WHERE status IN ('started', 'unknown')`.execute(db)

    await sql`
      CREATE TABLE order_item_fulfillment_attempts (
        id uuid PRIMARY KEY,
        order_item_id uuid NOT NULL,
        operation_id uuid NOT NULL UNIQUE,
        quantity integer NOT NULL,
        status varchar(16) NOT NULL DEFAULT 'processing',
        result_sha256 char(64),
        created_at timestamptz NOT NULL DEFAULT now(),
        completed_at timestamptz,
        CONSTRAINT order_item_fulfillment_attempts_item_fkey FOREIGN KEY (order_item_id) REFERENCES order_items (id) ON DELETE RESTRICT,
        CONSTRAINT order_item_fulfillment_attempts_quantity_check CHECK (quantity > 0),
        CONSTRAINT order_item_fulfillment_attempts_status_check CHECK (status IN ('processing', 'unknown', 'succeeded', 'failed')),
        CONSTRAINT order_item_fulfillment_attempts_hash_check CHECK (result_sha256 IS NULL OR result_sha256 ~ '^[0-9a-f]{64}$')
      )
    `.execute(db)
    await sql`CREATE INDEX order_item_fulfillment_attempts_item_created_idx ON order_item_fulfillment_attempts (order_item_id, created_at, id)`.execute(db)

    await sql`
      CREATE TABLE order_status_events (
        id uuid PRIMARY KEY,
        operation_id uuid NOT NULL UNIQUE,
        order_id uuid NOT NULL,
        previous_status varchar(24) NOT NULL,
        next_status varchar(24) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT order_status_events_order_fkey FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE RESTRICT,
        CONSTRAINT order_status_events_previous_check CHECK (previous_status IN ('pending_payment', 'processing', 'completed', 'closed')),
        CONSTRAINT order_status_events_next_check CHECK (next_status IN ('pending_payment', 'processing', 'completed', 'closed')),
        CONSTRAINT order_status_events_transition_check CHECK (previous_status <> next_status)
      )
    `.execute(db)
    await sql`CREATE INDEX order_status_events_order_created_idx ON order_status_events (order_id, created_at, id)`.execute(db)

    await sql`ALTER TABLE wallet_ledger_entries ADD CONSTRAINT wallet_ledger_entries_withdrawal_fkey FOREIGN KEY (withdrawal_id) REFERENCES withdrawals (id) ON DELETE RESTRICT`.execute(db)
    await sql`ALTER TABLE wallet_ledger_entries ADD CONSTRAINT wallet_ledger_entries_refund_fkey FOREIGN KEY (refund_allocation_id) REFERENCES order_refund_allocations (id) ON DELETE RESTRICT`.execute(db)

    // All order snapshots retain their source identities. A product or SKU cannot
    // be physically deleted after it has appeared on a transaction.
    await sql`
      CREATE FUNCTION forbid_ordered_product_type_change() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.product_type IS DISTINCT FROM NEW.product_type
          AND EXISTS (SELECT 1 FROM order_items WHERE product_id = OLD.id) THEN
          RAISE EXCEPTION 'Product type is immutable after an order references it'
            USING ERRCODE = '23514', CONSTRAINT = 'product_type_order_reference';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER products_order_type_immutable BEFORE UPDATE OF product_type ON products FOR EACH ROW EXECUTE FUNCTION forbid_ordered_product_type_change()`.execute(db)

    await sql`
      CREATE FUNCTION enforce_customer_policy() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE policy storefront_customer_policy%ROWTYPE;
      BEGIN
        IF NEW.status <> 'deleted' THEN
          SELECT * INTO policy FROM storefront_customer_policy WHERE singleton;
          IF policy.require_email AND NEW.email IS NULL THEN
            RAISE EXCEPTION 'Store policy requires a customer email address'
              USING ERRCODE = '23514', CONSTRAINT = 'customers_email_required_by_policy';
          END IF;
          IF policy.require_phone AND NEW.phone IS NULL THEN
            RAISE EXCEPTION 'Store policy requires a customer phone number'
              USING ERRCODE = '23514', CONSTRAINT = 'customers_phone_required_by_policy';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER customers_enforce_store_policy BEFORE INSERT OR UPDATE OF status, email, phone ON customers FOR EACH ROW EXECUTE FUNCTION enforce_customer_policy()`.execute(db)

    await sql`
      CREATE FUNCTION prevent_customer_resurrection() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status = 'deleted' AND NEW.status <> 'deleted' THEN
          RAISE EXCEPTION 'A deleted customer identity cannot be restored'
            USING ERRCODE = '23514', CONSTRAINT = 'customers_deleted_terminal';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER customers_deleted_terminal BEFORE UPDATE OF status ON customers FOR EACH ROW EXECUTE FUNCTION prevent_customer_resurrection()`.execute(db)

    await sql`
      CREATE FUNCTION create_customer_wallet_account() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO wallet_accounts (customer_id) VALUES (NEW.id);
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER customers_create_wallet_account AFTER INSERT ON customers FOR EACH ROW EXECUTE FUNCTION create_customer_wallet_account()`.execute(db)

    await sql`
      CREATE FUNCTION guard_wallet_account_balance_write() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF ROW(NEW.cash_available, NEW.cash_frozen, NEW.gift_available, NEW.gift_frozen)
          IS DISTINCT FROM ROW(OLD.cash_available, OLD.cash_frozen, OLD.gift_available, OLD.gift_frozen)
          AND pg_trigger_depth() < 2 THEN
          RAISE EXCEPTION 'Wallet balances can only be changed by an immutable ledger entry'
            USING ERRCODE = '23514', CONSTRAINT = 'wallet_balance_requires_ledger';
        END IF;
        IF ROW(NEW.cash_available, NEW.cash_frozen, NEW.gift_available, NEW.gift_frozen)
          IS DISTINCT FROM ROW(OLD.cash_available, OLD.cash_frozen, OLD.gift_available, OLD.gift_frozen) THEN
          NEW.updated_at := now();
        ELSE
          NEW.updated_at := OLD.updated_at;
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER wallet_accounts_balance_guard BEFORE UPDATE ON wallet_accounts FOR EACH ROW EXECUTE FUNCTION guard_wallet_account_balance_write()`.execute(db)

    await sql`
      CREATE FUNCTION protect_immutable_trade_history() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'Trade and accounting history is immutable'
          USING ERRCODE = '23514', CONSTRAINT = TG_TABLE_NAME || '_immutable';
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER storefront_customer_policy_prevent_delete BEFORE DELETE ON storefront_customer_policy FOR EACH ROW EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)
    await sql`CREATE TRIGGER storefront_customer_policy_prevent_truncate BEFORE TRUNCATE ON storefront_customer_policy FOR EACH STATEMENT EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)
    await sql`CREATE TRIGGER wallet_operations_immutable BEFORE UPDATE OR DELETE ON wallet_operations FOR EACH ROW EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)
    await sql`CREATE TRIGGER wallet_operations_prevent_truncate BEFORE TRUNCATE ON wallet_operations FOR EACH STATEMENT EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)
    await sql`CREATE TRIGGER wallet_ledger_entries_immutable BEFORE UPDATE OR DELETE ON wallet_ledger_entries FOR EACH ROW EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)
    await sql`CREATE TRIGGER wallet_ledger_entries_prevent_truncate BEFORE TRUNCATE ON wallet_ledger_entries FOR EACH STATEMENT EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)
    await sql`CREATE TRIGGER order_inventory_events_immutable BEFORE UPDATE OR DELETE ON order_inventory_events FOR EACH ROW EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)
    await sql`CREATE TRIGGER order_inventory_events_prevent_truncate BEFORE TRUNCATE ON order_inventory_events FOR EACH STATEMENT EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)
    await sql`CREATE TRIGGER order_status_events_immutable BEFORE UPDATE OR DELETE ON order_status_events FOR EACH ROW EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)
    await sql`CREATE TRIGGER order_status_events_prevent_truncate BEFORE TRUNCATE ON order_status_events FOR EACH STATEMENT EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)
    await sql`CREATE TRIGGER customers_prevent_delete BEFORE DELETE ON customers FOR EACH ROW EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)
    await sql`CREATE TRIGGER customers_prevent_truncate BEFORE TRUNCATE ON customers FOR EACH STATEMENT EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)
    await sql`CREATE TRIGGER wallet_accounts_prevent_delete BEFORE DELETE ON wallet_accounts FOR EACH ROW EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)
    await sql`CREATE TRIGGER wallet_accounts_prevent_truncate BEFORE TRUNCATE ON wallet_accounts FOR EACH STATEMENT EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)
    await sql`CREATE TRIGGER orders_prevent_delete BEFORE DELETE ON orders FOR EACH ROW EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)
    await sql`CREATE TRIGGER orders_prevent_truncate BEFORE TRUNCATE ON orders FOR EACH STATEMENT EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)
    await sql`CREATE TRIGGER order_items_prevent_truncate BEFORE TRUNCATE ON order_items FOR EACH STATEMENT EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)
    await sql`CREATE TRIGGER order_inventory_reservations_prevent_mutation BEFORE UPDATE OR DELETE ON order_inventory_reservations FOR EACH ROW EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)
    await sql`CREATE TRIGGER order_inventory_reservations_prevent_truncate BEFORE TRUNCATE ON order_inventory_reservations FOR EACH STATEMENT EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)
    await sql`CREATE TRIGGER payment_attempts_prevent_delete BEFORE DELETE ON payment_attempts FOR EACH ROW EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)
    await sql`CREATE TRIGGER payment_attempts_prevent_truncate BEFORE TRUNCATE ON payment_attempts FOR EACH STATEMENT EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)
    await sql`CREATE TRIGGER order_refunds_prevent_delete BEFORE DELETE ON order_refunds FOR EACH ROW EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)
    await sql`CREATE TRIGGER order_refunds_prevent_truncate BEFORE TRUNCATE ON order_refunds FOR EACH STATEMENT EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)
    await sql`CREATE TRIGGER withdrawals_prevent_delete BEFORE DELETE ON withdrawals FOR EACH ROW EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)
    await sql`CREATE TRIGGER withdrawals_prevent_truncate BEFORE TRUNCATE ON withdrawals FOR EACH STATEMENT EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)
    await sql`CREATE TRIGGER order_item_fulfillment_attempts_prevent_truncate BEFORE TRUNCATE ON order_item_fulfillment_attempts FOR EACH STATEMENT EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)

    await sql`
      CREATE FUNCTION apply_wallet_ledger_entry() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        operation_kind varchar(24);
        expected_customer uuid;
      BEGIN
        SELECT operation_type, customer_id INTO operation_kind, expected_customer
        FROM wallet_operations WHERE id = NEW.wallet_operation_id;
        IF NOT FOUND OR expected_customer <> NEW.customer_id THEN
          RAISE EXCEPTION 'Wallet operation does not belong to this account'
            USING ERRCODE = '23514', CONSTRAINT = 'wallet_ledger_operation_owner';
        END IF;

        IF NOT (
          (operation_kind = 'top_up' AND NEW.bucket = 'cash' AND NEW.action = 'credit_available')
          OR (operation_kind = 'order_payment' AND NEW.action = 'debit_available')
          OR (operation_kind = 'refund' AND NEW.action = 'credit_available')
          OR (operation_kind = 'gift' AND NEW.bucket = 'gift' AND NEW.action = 'credit_available')
          OR (operation_kind = 'withdrawal_freeze' AND NEW.bucket = 'cash' AND NEW.action = 'freeze')
          OR (operation_kind = 'withdrawal_release' AND NEW.bucket = 'cash' AND NEW.action = 'unfreeze')
          OR (operation_kind = 'withdrawal_complete' AND NEW.bucket = 'cash' AND NEW.action = 'debit_frozen')
          OR (operation_kind = 'adjustment' AND NEW.action IN ('credit_available', 'debit_available'))
        ) THEN
          RAISE EXCEPTION 'Wallet entry does not match the operation type or balance bucket'
            USING ERRCODE = '23514', CONSTRAINT = 'wallet_ledger_operation_action';
        END IF;

        IF (operation_kind IN ('top_up', 'order_payment') AND NEW.payment_attempt_id IS NULL)
          OR (operation_kind = 'refund' AND NEW.refund_allocation_id IS NULL)
          OR (operation_kind IN ('withdrawal_freeze', 'withdrawal_release', 'withdrawal_complete') AND NEW.withdrawal_id IS NULL)
          OR (operation_kind IN ('gift', 'adjustment') AND num_nonnulls(
            NEW.payment_attempt_id, NEW.refund_allocation_id, NEW.withdrawal_id
          ) <> 0) THEN
          RAISE EXCEPTION 'Wallet operation requires its matching immutable source record'
            USING ERRCODE = '23514', CONSTRAINT = 'wallet_ledger_source_required';
        END IF;

        IF NEW.payment_attempt_id IS NOT NULL THEN
          IF NOT EXISTS (
            SELECT 1 FROM payment_attempts AS attempt
            WHERE attempt.id = NEW.payment_attempt_id
              AND ((operation_kind = 'order_payment' AND attempt.wallet_operation_id = NEW.wallet_operation_id
                  AND attempt.source = 'wallet')
                OR (operation_kind = 'top_up' AND attempt.source = 'external'
                  AND attempt.topup_customer_id = NEW.customer_id))
              AND NEW.bucket IN ('cash', 'gift')
          ) THEN
            RAISE EXCEPTION 'Wallet payment entry must match its payment attempt'
              USING ERRCODE = '23514', CONSTRAINT = 'wallet_ledger_payment_source';
          END IF;
          IF operation_kind = 'top_up' AND (NEW.bucket <> 'cash' OR NEW.action <> 'credit_available'
            OR NOT EXISTS (
              SELECT 1 FROM payment_receipts AS receipt
              JOIN payment_attempts AS attempt ON attempt.id = receipt.payment_attempt_id
              WHERE receipt.payment_attempt_id = NEW.payment_attempt_id
                AND receipt.source_bucket = 'external' AND receipt.disposition = 'on_time'
                AND receipt.amount = NEW.amount AND attempt.amount = NEW.amount
                AND attempt.status = 'succeeded'
            )) THEN
            RAISE EXCEPTION 'Top-up credits require an equal confirmed external receipt'
              USING ERRCODE = '23514', CONSTRAINT = 'wallet_top_up_receipt_required';
          END IF;
        END IF;
        IF NEW.refund_allocation_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM order_refund_allocations AS allocation
          WHERE allocation.id = NEW.refund_allocation_id
            AND allocation.operation_id = NEW.wallet_operation_id
            AND allocation.status = 'succeeded'
            AND ((allocation.destination = 'cash_balance' AND NEW.bucket = 'cash')
              OR (allocation.destination = 'gift_balance' AND NEW.bucket = 'gift'))
            AND allocation.amount = NEW.amount
        ) THEN
          RAISE EXCEPTION 'Wallet refund entry must match a successful refund allocation'
            USING ERRCODE = '23514', CONSTRAINT = 'wallet_ledger_refund_source';
        END IF;
        IF NEW.withdrawal_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM withdrawals AS withdrawal
          WHERE withdrawal.id = NEW.withdrawal_id
            AND withdrawal.customer_id = NEW.customer_id
            AND withdrawal.amount = NEW.amount
            AND (
              (operation_kind = 'withdrawal_freeze' AND withdrawal.wallet_operation_id = NEW.wallet_operation_id
                AND withdrawal.status IN ('pending_review', 'pending_transfer', 'transfer_processing', 'transfer_uncertain'))
              OR (operation_kind = 'withdrawal_release' AND withdrawal.status IN ('rejected', 'cancelled'))
              OR (operation_kind = 'withdrawal_complete' AND withdrawal.status = 'completed')
            )
            AND ((operation_kind = 'withdrawal_freeze' AND NEW.action = 'freeze')
              OR (operation_kind = 'withdrawal_release' AND NEW.action = 'unfreeze')
              OR (operation_kind = 'withdrawal_complete' AND NEW.action = 'debit_frozen'))
        ) THEN
          RAISE EXCEPTION 'Wallet entry must match its withdrawal'
            USING ERRCODE = '23514', CONSTRAINT = 'wallet_ledger_withdrawal_source';
        END IF;

        IF NEW.bucket = 'cash' THEN
          UPDATE wallet_accounts SET
            cash_available = cash_available + CASE NEW.action
              WHEN 'credit_available' THEN NEW.amount
              WHEN 'debit_available' THEN -NEW.amount
              WHEN 'freeze' THEN -NEW.amount
              WHEN 'unfreeze' THEN NEW.amount
              ELSE 0 END,
            cash_frozen = cash_frozen + CASE NEW.action
              WHEN 'freeze' THEN NEW.amount
              WHEN 'unfreeze' THEN -NEW.amount
              WHEN 'debit_frozen' THEN -NEW.amount
              ELSE 0 END
          WHERE customer_id = NEW.customer_id;
        ELSE
          UPDATE wallet_accounts SET
            gift_available = gift_available + CASE NEW.action
              WHEN 'credit_available' THEN NEW.amount
              WHEN 'debit_available' THEN -NEW.amount
              WHEN 'freeze' THEN -NEW.amount
              WHEN 'unfreeze' THEN NEW.amount
              ELSE 0 END,
            gift_frozen = gift_frozen + CASE NEW.action
              WHEN 'freeze' THEN NEW.amount
              WHEN 'unfreeze' THEN -NEW.amount
              WHEN 'debit_frozen' THEN -NEW.amount
              ELSE 0 END
          WHERE customer_id = NEW.customer_id;
        END IF;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Wallet account is missing'
            USING ERRCODE = '23503', CONSTRAINT = 'wallet_ledger_account_fkey';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER wallet_ledger_entries_apply AFTER INSERT ON wallet_ledger_entries FOR EACH ROW EXECUTE FUNCTION apply_wallet_ledger_entry()`.execute(db)

    await sql`
      CREATE FUNCTION assert_wallet_operation_entries() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        entry_count bigint;
        expected_amount numeric(18, 2);
        linked_attempt uuid;
      BEGIN
        SELECT count(*) INTO entry_count
        FROM wallet_ledger_entries WHERE wallet_operation_id = NEW.id;
        IF entry_count = 0 THEN
          RAISE EXCEPTION 'Wallet operations must commit with at least one immutable ledger entry'
            USING ERRCODE = '23514', CONSTRAINT = 'wallet_operation_requires_ledger';
        END IF;

        IF NEW.operation_type = 'top_up' THEN
          SELECT min(payment_attempt_id::text)::uuid, sum(amount) INTO linked_attempt, expected_amount
          FROM wallet_ledger_entries WHERE wallet_operation_id = NEW.id;
          IF entry_count <> 1 OR NOT EXISTS (
            SELECT 1 FROM payment_attempts AS attempt
            JOIN payment_receipts AS receipt ON receipt.payment_attempt_id = attempt.id
            WHERE attempt.id = linked_attempt AND attempt.source = 'external'
              AND attempt.topup_customer_id = NEW.customer_id AND attempt.status = 'succeeded'
              AND attempt.amount = expected_amount AND receipt.disposition = 'on_time'
              AND receipt.amount = expected_amount
          ) THEN
            RAISE EXCEPTION 'Top-up wallet operation must match one confirmed external settlement'
              USING ERRCODE = '23514', CONSTRAINT = 'wallet_top_up_ledger_match';
          END IF;
        ELSIF NEW.operation_type = 'order_payment' THEN
          SELECT min(payment_attempt_id::text)::uuid, sum(amount) INTO linked_attempt, expected_amount
          FROM wallet_ledger_entries WHERE wallet_operation_id = NEW.id;
          IF NOT EXISTS (
            SELECT 1 FROM payment_attempts AS attempt
            WHERE attempt.id = linked_attempt AND attempt.wallet_operation_id = NEW.id
              AND attempt.source = 'wallet' AND attempt.amount = expected_amount
              AND attempt.status = 'succeeded'
          ) OR entry_count <> (SELECT count(*) FROM payment_receipts WHERE payment_attempt_id = linked_attempt)
            OR expected_amount <> (SELECT COALESCE(sum(amount), 0) FROM payment_receipts WHERE payment_attempt_id = linked_attempt) THEN
            RAISE EXCEPTION 'Wallet order payment must balance to its confirmed payment attempt receipts'
              USING ERRCODE = '23514', CONSTRAINT = 'wallet_order_payment_ledger_match';
          END IF;
        END IF;
        RETURN NULL;
      END;
      $$
    `.execute(db)
    await sql`CREATE CONSTRAINT TRIGGER wallet_operations_require_entries AFTER INSERT ON wallet_operations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_wallet_operation_entries()`.execute(db)

    await sql`
      CREATE FUNCTION validate_new_order() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        policy storefront_customer_policy%ROWTYPE;
        customer_status varchar(16);
        session_expires_at timestamptz;
        session_revoked_at timestamptz;
      BEGIN
        SELECT * INTO policy FROM storefront_customer_policy WHERE singleton FOR SHARE;
        IF NEW.customer_id IS NOT NULL THEN
          SELECT status INTO customer_status FROM customers WHERE id = NEW.customer_id FOR KEY SHARE;
          IF NOT FOUND OR customer_status <> 'active' THEN
            RAISE EXCEPTION 'Only active customer accounts can create orders'
              USING ERRCODE = '23514', CONSTRAINT = 'orders_customer_must_be_active';
          END IF;
        ELSE
          SELECT expires_at, revoked_at INTO session_expires_at, session_revoked_at
          FROM guest_order_sessions WHERE id = NEW.guest_order_session_id FOR KEY SHARE;
          IF NOT FOUND OR session_revoked_at IS NOT NULL OR session_expires_at <= clock_timestamp() THEN
            RAISE EXCEPTION 'A valid guest order session is required'
              USING ERRCODE = '23514', CONSTRAINT = 'orders_guest_session_must_be_active';
          END IF;
          IF NEW.total_amount = 0 THEN
            IF NOT policy.guest_free_claim_enabled THEN
              RAISE EXCEPTION 'Guest claims for free items are disabled'
                USING ERRCODE = '23514', CONSTRAINT = 'orders_guest_free_claim_disabled';
            END IF;
          ELSIF NOT policy.guest_checkout_enabled THEN
            RAISE EXCEPTION 'Guest checkout is disabled'
              USING ERRCODE = '23514', CONSTRAINT = 'orders_guest_checkout_disabled';
          END IF;
        END IF;

        IF NEW.total_amount = 0 THEN
          NEW.status := 'processing';
          NEW.unpaid_expires_at := NULL;
        ELSE
          NEW.status := 'pending_payment';
          NEW.unpaid_expires_at := clock_timestamp() + make_interval(mins => policy.unpaid_order_timeout_minutes);
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER orders_validate_owner BEFORE INSERT ON orders FOR EACH ROW EXECUTE FUNCTION validate_new_order()`.execute(db)

    await sql`
      CREATE FUNCTION guard_order_update() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        paid_amount numeric;
        has_unresolved boolean;
        all_items_complete boolean;
      BEGIN
        IF ROW(NEW.id, NEW.customer_id, NEW.guest_order_session_id, NEW.idempotency_key,
               NEW.request_sha256, NEW.total_amount, NEW.currency, NEW.created_at,
               NEW.unpaid_expires_at)
          IS DISTINCT FROM ROW(OLD.id, OLD.customer_id, OLD.guest_order_session_id, OLD.idempotency_key,
               OLD.request_sha256, OLD.total_amount, OLD.currency, OLD.created_at,
               OLD.unpaid_expires_at) THEN
          RAISE EXCEPTION 'Order ownership, idempotency and amount snapshots are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'orders_identity_immutable';
        END IF;

        IF OLD.status IS DISTINCT FROM NEW.status THEN
          IF NOT ((OLD.status = 'pending_payment' AND NEW.status IN ('processing', 'closed'))
            OR (OLD.status = 'processing' AND NEW.status IN ('completed', 'closed'))) THEN
            RAISE EXCEPTION 'Illegal order status transition: % to %', OLD.status, NEW.status
              USING ERRCODE = '23514', CONSTRAINT = 'orders_status_transition';
          END IF;
          IF NEW.status = 'processing' AND OLD.status = 'pending_payment' THEN
            SELECT COALESCE(sum(receipt.amount), 0), COALESCE(bool_or(receipt.disposition IN ('late', 'amount_mismatch', 'excess')), false)
              INTO paid_amount, has_unresolved FROM payment_receipts AS receipt
              JOIN payment_attempts AS attempt ON attempt.id = receipt.payment_attempt_id
              WHERE attempt.order_id = OLD.id;
            IF OLD.total_amount > 0 AND (paid_amount < OLD.total_amount OR has_unresolved) THEN
              RAISE EXCEPTION 'An order requires confirmed on-time payment before processing'
                USING ERRCODE = '23514', CONSTRAINT = 'orders_processing_requires_payment';
            END IF;
          END IF;
          IF NEW.status = 'completed' THEN
            SELECT count(*) > 0 AND bool_and(
              item.fulfillment_status = 'completed' AND item.fulfilled_quantity = item.quantity
            ) INTO all_items_complete FROM order_items AS item WHERE item.order_id = OLD.id;
            IF NOT COALESCE(all_items_complete, false) THEN
              RAISE EXCEPTION 'Every order item must be fully fulfilled before order completion'
                USING ERRCODE = '23514', CONSTRAINT = 'orders_completion_requires_fulfillment';
            END IF;
          END IF;
        END IF;

        IF ROW(NEW.history_hidden_at, NEW.history_hidden_by_admin_id, NEW.history_hidden_reason)
          IS DISTINCT FROM ROW(OLD.history_hidden_at, OLD.history_hidden_by_admin_id, OLD.history_hidden_reason) THEN
          IF OLD.history_hidden_at IS NOT NULL OR NEW.history_hidden_at IS NULL THEN
            RAISE EXCEPTION 'Order history hiding is a one-way audited action'
              USING ERRCODE = '23514', CONSTRAINT = 'orders_history_visibility_transition';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER orders_guard_update BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION guard_order_update()`.execute(db)

    await sql`
      CREATE FUNCTION validate_order_item_snapshot() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        order_state varchar(24);
        product_name varchar(200);
        product_type varchar(16);
        product_status varchar(16);
        sku_code varchar(64);
        sale_price numeric(18, 5);
        inventory_mode varchar(16);
        sku_enabled boolean;
        sku_retired_at timestamptz;
        fulfillment_method varchar(24);
        option_snapshot jsonb;
      BEGIN
        SELECT status INTO order_state FROM orders WHERE id = NEW.order_id FOR UPDATE;
        IF NOT FOUND OR order_state NOT IN ('pending_payment', 'processing') THEN
          RAISE EXCEPTION 'Order items can only be added while an order is being created'
            USING ERRCODE = '23514', CONSTRAINT = 'order_items_order_open_check';
        END IF;
        IF NEW.fulfillment_status <> 'pending' OR NEW.fulfilled_quantity <> 0
          OR NEW.fulfillment_reserved_quantity <> 0 THEN
          RAISE EXCEPTION 'Order item fulfillment must begin with no delivered or reserved quantity'
            USING ERRCODE = '23514', CONSTRAINT = 'order_items_initial_fulfillment_state';
        END IF;
        PERFORM id FROM products WHERE id = NEW.product_id FOR SHARE;
        SELECT product.name, product.product_type, product.status
          INTO product_name, product_type, product_status
        FROM products AS product WHERE product.id = NEW.product_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Order item product does not exist'
            USING ERRCODE = '23503', CONSTRAINT = 'order_items_product_fkey';
        END IF;
        SELECT variant.sku_code, variant.sale_price, variant.inventory_mode, variant.enabled, variant.retired_at
          INTO sku_code, sale_price, inventory_mode, sku_enabled, sku_retired_at
        FROM product_variants AS variant
        WHERE variant.product_id = NEW.product_id AND variant.id = NEW.product_variant_id FOR SHARE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Order item SKU does not belong to its product'
            USING ERRCODE = '23503', CONSTRAINT = 'order_items_variant_fkey';
        END IF;
        SELECT method INTO fulfillment_method FROM product_variant_fulfillment
        WHERE product_variant_id = NEW.product_variant_id FOR SHARE;
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'groupId', option_group.id,
          'groupName', option_group.name,
          'valueId', option_value.id,
          'valueName', option_value.name
        ) ORDER BY option_group.sort_order, option_value.sort_order, option_group.id, option_value.id), '[]'::jsonb)
        INTO option_snapshot
        FROM product_variant_option_values AS selected
        JOIN product_option_groups AS option_group
          ON option_group.product_id = selected.product_id AND option_group.id = selected.option_group_id
        JOIN product_option_values AS option_value
          ON option_value.product_id = selected.product_id AND option_value.option_group_id = selected.option_group_id
            AND option_value.id = selected.option_value_id
        WHERE selected.product_id = NEW.product_id AND selected.product_variant_id = NEW.product_variant_id;
        IF product_status <> 'active' OR NOT sku_enabled OR sku_retired_at IS NOT NULL THEN
          RAISE EXCEPTION 'Only active products and enabled, non-retired SKUs can be ordered'
            USING ERRCODE = '23514', CONSTRAINT = 'order_items_sale_state_check';
        END IF;
        IF inventory_mode IS NULL OR inventory_mode NOT IN ('quantity', 'unlimited') OR fulfillment_method IS NULL THEN
          RAISE EXCEPTION 'The SKU does not have a ready inventory and fulfillment configuration'
            USING ERRCODE = '23514', CONSTRAINT = 'order_items_sale_readiness_check';
        END IF;
        IF NEW.product_name_snapshot <> product_name
          OR NEW.product_type_snapshot <> product_type
          OR NEW.sku_code_snapshot <> sku_code
          OR NEW.sku_snapshot <> option_snapshot
          OR NEW.inventory_mode_snapshot <> inventory_mode
          OR NEW.fulfillment_method_snapshot <> fulfillment_method
          OR NEW.unit_price <> sale_price::numeric(18, 2) THEN
          RAISE EXCEPTION 'Order item snapshots must match the locked catalog state'
            USING ERRCODE = '23514', CONSTRAINT = 'order_items_snapshot_consistency';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER order_items_validate_snapshot BEFORE INSERT ON order_items FOR EACH ROW EXECUTE FUNCTION validate_order_item_snapshot()`.execute(db)

    await sql`
      CREATE FUNCTION protect_order_item_snapshot() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'Order items are permanent transaction records'
            USING ERRCODE = '23514', CONSTRAINT = 'order_items_immutable';
        END IF;
        IF ROW(NEW.id, NEW.order_id, NEW.product_id, NEW.product_variant_id,
               NEW.product_name_snapshot, NEW.product_type_snapshot, NEW.sku_code_snapshot,
               NEW.sku_snapshot, NEW.inventory_mode_snapshot, NEW.fulfillment_method_snapshot,
               NEW.unit_price, NEW.quantity, NEW.line_amount, NEW.created_at)
          IS DISTINCT FROM ROW(OLD.id, OLD.order_id, OLD.product_id, OLD.product_variant_id,
               OLD.product_name_snapshot, OLD.product_type_snapshot, OLD.sku_code_snapshot,
               OLD.sku_snapshot, OLD.inventory_mode_snapshot, OLD.fulfillment_method_snapshot,
               OLD.unit_price, OLD.quantity, OLD.line_amount, OLD.created_at) THEN
          RAISE EXCEPTION 'Order item identity and purchase snapshots are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'order_items_snapshot_immutable';
        END IF;
        IF ROW(NEW.fulfilled_quantity, NEW.fulfillment_reserved_quantity, NEW.fulfillment_status)
          IS DISTINCT FROM ROW(OLD.fulfilled_quantity, OLD.fulfillment_reserved_quantity, OLD.fulfillment_status)
          AND pg_trigger_depth() < 2 THEN
          RAISE EXCEPTION 'Fulfillment summary can only be changed by fulfillment records'
            USING ERRCODE = '23514', CONSTRAINT = 'order_items_fulfillment_requires_record';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER order_items_snapshot_guard BEFORE UPDATE OR DELETE ON order_items FOR EACH ROW EXECUTE FUNCTION protect_order_item_snapshot()`.execute(db)

    await sql`
      CREATE FUNCTION assert_order_amount_and_inventory() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        order_uuid uuid;
        expected_amount numeric(18, 2);
        actual_amount numeric;
        item_count bigint;
        reservation_count bigint;
        reserve_event_count bigint;
        item_uuid uuid;
      BEGIN
        IF TG_TABLE_NAME = 'orders' THEN
          order_uuid := COALESCE(NEW.id, OLD.id);
        ELSIF TG_TABLE_NAME = 'order_inventory_reservations' THEN
          SELECT item.order_id INTO order_uuid
          FROM order_items AS item WHERE item.id = COALESCE(NEW.order_item_id, OLD.order_item_id);
        ELSE
          order_uuid := COALESCE(NEW.order_id, OLD.order_id);
        END IF;
        IF order_uuid IS NULL OR NOT EXISTS (SELECT 1 FROM orders WHERE id = order_uuid) THEN
          RETURN NULL;
        END IF;

        SELECT total_amount INTO expected_amount FROM orders WHERE id = order_uuid;
        SELECT COALESCE(sum(line_amount), 0), count(*) INTO actual_amount, item_count
        FROM order_items WHERE order_id = order_uuid;
        IF actual_amount <> expected_amount OR item_count = 0 THEN
          RAISE EXCEPTION 'Order amount must equal the immutable sum of at least one order item'
            USING ERRCODE = '23514', CONSTRAINT = 'orders_amount_matches_items';
        END IF;

        IF TG_TABLE_NAME = 'orders' THEN
          PERFORM assert_order_amount_and_inventory_for_items(order_uuid);
        ELSIF TG_TABLE_NAME = 'order_items' THEN
          IF TG_OP = 'DELETE' THEN item_uuid := OLD.id; ELSE item_uuid := NEW.id; END IF;
          PERFORM assert_order_item_inventory(item_uuid, order_uuid);
        ELSIF TG_TABLE_NAME = 'order_inventory_reservations' THEN
          IF TG_OP = 'DELETE' THEN item_uuid := OLD.order_item_id; ELSE item_uuid := NEW.order_item_id; END IF;
          PERFORM assert_order_item_inventory(item_uuid, order_uuid);
        END IF;
        RETURN NULL;
      END;
      $$
    `.execute(db)

    await sql`
      CREATE FUNCTION assert_order_item_inventory(item_uuid uuid, order_uuid uuid) RETURNS void
      LANGUAGE plpgsql AS $$
      DECLARE
        mode_snapshot varchar(16);
        reservation_total bigint;
        reserve_event_total bigint;
      BEGIN
        SELECT inventory_mode_snapshot INTO mode_snapshot FROM order_items WHERE id = item_uuid;
        IF NOT FOUND THEN RETURN; END IF;
        SELECT count(*) INTO reservation_total FROM order_inventory_reservations WHERE order_item_id = item_uuid;
        SELECT count(*) INTO reserve_event_total
        FROM order_inventory_events AS event
        JOIN order_inventory_reservations AS reservation ON reservation.id = event.reservation_id
        WHERE reservation.order_item_id = item_uuid AND event.action = 'reserve';
        IF mode_snapshot = 'quantity' AND (reservation_total <> 1 OR reserve_event_total <> 1) THEN
          RAISE EXCEPTION 'Quantity-mode order items require exactly one inventory reservation'
            USING ERRCODE = '23514', CONSTRAINT = 'order_items_quantity_reservation_required';
        END IF;
        IF mode_snapshot = 'unlimited' AND (reservation_total <> 0 OR reserve_event_total <> 0) THEN
          RAISE EXCEPTION 'Unlimited-mode order items cannot reserve quantity inventory'
            USING ERRCODE = '23514', CONSTRAINT = 'order_items_unlimited_reservation_forbidden';
        END IF;
      END;
      $$
    `.execute(db)
    await sql`
      CREATE FUNCTION assert_order_amount_and_inventory_for_items(order_uuid uuid) RETURNS void
      LANGUAGE plpgsql AS $$
      DECLARE item_row record;
      BEGIN
        FOR item_row IN SELECT id FROM order_items WHERE order_id = order_uuid LOOP
          PERFORM assert_order_item_inventory(item_row.id, order_uuid);
        END LOOP;
      END;
      $$
    `.execute(db)
    await sql`CREATE CONSTRAINT TRIGGER orders_amount_inventory_check AFTER INSERT OR UPDATE ON orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_order_amount_and_inventory()`.execute(db)
    await sql`CREATE CONSTRAINT TRIGGER order_items_amount_inventory_check AFTER INSERT OR UPDATE OR DELETE ON order_items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_order_amount_and_inventory()`.execute(db)
    await sql`CREATE CONSTRAINT TRIGGER order_inventory_reservations_consistency_check AFTER INSERT OR UPDATE OR DELETE ON order_inventory_reservations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_order_amount_and_inventory()`.execute(db)

    await sql`
      CREATE FUNCTION create_initial_inventory_reservation_event() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO order_inventory_events (id, reservation_id, operation_id, action, quantity)
        VALUES (gen_random_uuid(), NEW.id, NEW.id, 'reserve', NEW.quantity);
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER order_inventory_reservations_create_event AFTER INSERT ON order_inventory_reservations FOR EACH ROW EXECUTE FUNCTION create_initial_inventory_reservation_event()`.execute(db)

    await sql`
      CREATE FUNCTION apply_order_inventory_event() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        reservation order_inventory_reservations%ROWTYPE;
        order_uuid uuid;
        order_state varchar(24);
        item_fulfillment_reserved integer;
        inventory_row product_variant_quantity_inventory%ROWTYPE;
        next_revision integer;
        reserved_before bigint;
      BEGIN
        SELECT * INTO reservation FROM order_inventory_reservations WHERE id = NEW.reservation_id;
        SELECT item.order_id, item.fulfillment_reserved_quantity INTO order_uuid, item_fulfillment_reserved
        FROM order_items AS item WHERE item.id = reservation.order_item_id;
        SELECT status INTO order_state FROM orders WHERE id = order_uuid;

        -- Match the D3 writer order: SKU row first, then quantity inventory row.
        PERFORM id FROM product_variants WHERE id = reservation.product_variant_id FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Reserved SKU no longer exists'
            USING ERRCODE = '23503', CONSTRAINT = 'order_inventory_variant_fkey';
        END IF;
        SELECT * INTO inventory_row FROM product_variant_quantity_inventory
        WHERE product_id = reservation.product_id AND product_variant_id = reservation.product_variant_id FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Quantity inventory state is missing for a reservation'
            USING ERRCODE = '23514', CONSTRAINT = 'order_inventory_quantity_state_required';
        END IF;
        IF (SELECT inventory_mode FROM product_variants WHERE id = reservation.product_variant_id) <> 'quantity' THEN
          RAISE EXCEPTION 'Order inventory movements require quantity inventory mode'
            USING ERRCODE = '23514', CONSTRAINT = 'order_inventory_mode_check';
        END IF;

        SELECT
          COALESCE(sum(quantity) FILTER (WHERE action = 'reserve'), 0)
          - COALESCE(sum(quantity) FILTER (WHERE action IN ('release', 'consume')), 0)
          INTO reserved_before
        FROM order_inventory_events WHERE reservation_id = NEW.reservation_id AND id <> NEW.id;

        IF NEW.action = 'reserve' THEN
          IF order_state NOT IN ('pending_payment', 'processing') OR NEW.quantity <> reservation.quantity
            OR reserved_before <> 0 THEN
            RAISE EXCEPTION 'Initial reservation does not match an open order item'
              USING ERRCODE = '23514', CONSTRAINT = 'order_inventory_reservation_state';
          END IF;
          IF inventory_row.stocked - inventory_row.reserved < NEW.quantity THEN
            RAISE EXCEPTION 'Insufficient available quantity for order reservation'
              USING ERRCODE = '23514', CONSTRAINT = 'order_inventory_insufficient_stock';
          END IF;
          UPDATE product_variant_quantity_inventory SET reserved = reserved + NEW.quantity
          WHERE product_id = reservation.product_id AND product_variant_id = reservation.product_variant_id;
        ELSIF NEW.action = 'release' THEN
          IF order_state <> 'closed' OR NEW.quantity <> reserved_before - item_fulfillment_reserved
            OR NEW.quantity <= 0 THEN
            RAISE EXCEPTION 'Inventory can only release the unfulfilled remainder of a closed order'
              USING ERRCODE = '23514', CONSTRAINT = 'order_inventory_release_state';
          END IF;
          UPDATE product_variant_quantity_inventory SET reserved = reserved - NEW.quantity
          WHERE product_id = reservation.product_id AND product_variant_id = reservation.product_variant_id
            AND reserved >= NEW.quantity;
        ELSE
          IF NEW.quantity > reserved_before OR NOT EXISTS (
            SELECT 1 FROM order_item_fulfillment_attempts AS attempt
            WHERE attempt.operation_id = NEW.operation_id AND attempt.status = 'succeeded'
              AND attempt.order_item_id = reservation.order_item_id AND attempt.quantity = NEW.quantity
          ) THEN
            RAISE EXCEPTION 'Inventory consumption must match a successful fulfillment attempt and active reservation'
              USING ERRCODE = '23514', CONSTRAINT = 'order_inventory_consume_state';
          END IF;
          UPDATE product_variant_quantity_inventory SET stocked = stocked - NEW.quantity, reserved = reserved - NEW.quantity
          WHERE product_id = reservation.product_id AND product_variant_id = reservation.product_variant_id
            AND reserved >= NEW.quantity AND stocked >= NEW.quantity;
        END IF;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'Inventory movement would violate stocked and reserved quantities'
            USING ERRCODE = '23514', CONSTRAINT = 'order_inventory_quantity_bounds';
        END IF;
        UPDATE product_variants SET inventory_revision = inventory_revision + 1
        WHERE id = reservation.product_variant_id AND inventory_revision < 2147483647
        RETURNING inventory_revision INTO next_revision;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Inventory revision is exhausted'
            USING ERRCODE = '23514', CONSTRAINT = 'order_inventory_revision_exhausted';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER order_inventory_events_apply AFTER INSERT ON order_inventory_events FOR EACH ROW EXECUTE FUNCTION apply_order_inventory_event()`.execute(db)

    await sql`
      CREATE FUNCTION guard_reserved_inventory_write() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.reserved IS DISTINCT FROM OLD.reserved AND pg_trigger_depth() < 2 THEN
          RAISE EXCEPTION 'Reserved quantity can only be changed by order inventory events'
            USING ERRCODE = '23514', CONSTRAINT = 'inventory_reserved_requires_order_event';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER quantity_inventory_reserved_guard BEFORE UPDATE OF reserved ON product_variant_quantity_inventory FOR EACH ROW EXECUTE FUNCTION guard_reserved_inventory_write()`.execute(db)

    await sql`
      CREATE FUNCTION release_order_inventory_on_close() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE reservation_row record;
      DECLARE outstanding bigint;
      BEGIN
        IF OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'closed' THEN
          FOR reservation_row IN
            SELECT reservation.id, reservation.quantity, item.fulfillment_reserved_quantity
            FROM order_inventory_reservations AS reservation
            JOIN order_items AS item ON item.id = reservation.order_item_id
            WHERE item.order_id = NEW.id
            ORDER BY reservation.product_variant_id, reservation.id
          LOOP
            SELECT COALESCE(sum(quantity) FILTER (WHERE action = 'reserve'), 0)
              - COALESCE(sum(quantity) FILTER (WHERE action IN ('release', 'consume')), 0)
              INTO outstanding
            FROM order_inventory_events WHERE reservation_id = reservation_row.id;
            outstanding := outstanding - reservation_row.fulfillment_reserved_quantity;
            IF outstanding > 0 THEN
              INSERT INTO order_inventory_events (id, reservation_id, operation_id, action, quantity)
              VALUES (gen_random_uuid(), reservation_row.id, gen_random_uuid(), 'release', outstanding::integer);
            END IF;
          END LOOP;
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER orders_release_inventory_after_close AFTER UPDATE OF status ON orders FOR EACH ROW EXECUTE FUNCTION release_order_inventory_on_close()`.execute(db)

    await sql`
      CREATE FUNCTION record_order_status_event() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status IS DISTINCT FROM NEW.status THEN
          INSERT INTO order_status_events (id, operation_id, order_id, previous_status, next_status)
          VALUES (gen_random_uuid(), gen_random_uuid(), NEW.id, OLD.status, NEW.status);
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER orders_record_status_event AFTER UPDATE OF status ON orders FOR EACH ROW EXECUTE FUNCTION record_order_status_event()`.execute(db)

    await sql`
      CREATE FUNCTION validate_payment_attempt() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        order_row orders%ROWTYPE;
        owner_customer uuid;
      BEGIN
        IF NEW.status <> 'created' OR NEW.completed_at IS NOT NULL THEN
          RAISE EXCEPTION 'A payment attempt must start unconfirmed and incomplete'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_attempts_initial_state';
        END IF;
        IF NEW.order_id IS NOT NULL THEN
          SELECT * INTO order_row FROM orders WHERE id = NEW.order_id FOR UPDATE;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'Payment attempt order does not exist'
              USING ERRCODE = '23503', CONSTRAINT = 'payment_attempts_order_fkey';
          END IF;
          IF order_row.status <> 'pending_payment' OR order_row.total_amount <= 0
            OR order_row.unpaid_expires_at <= clock_timestamp() THEN
            RAISE EXCEPTION 'Closed, expired, or zero-value orders cannot start a payment attempt'
              USING ERRCODE = '23514', CONSTRAINT = 'payment_attempts_order_payable';
          END IF;
          IF NEW.source = 'wallet' AND order_row.customer_id IS NULL THEN
            RAISE EXCEPTION 'Guest orders cannot use customer wallet funds'
              USING ERRCODE = '23514', CONSTRAINT = 'payment_attempts_wallet_owner';
          END IF;
          IF NEW.source = 'wallet' THEN
            SELECT id INTO owner_customer FROM wallet_operations
            WHERE id = NEW.wallet_operation_id AND customer_id = order_row.customer_id
              AND operation_type = 'order_payment';
            IF NOT FOUND THEN
              RAISE EXCEPTION 'Wallet payment operation does not belong to the order customer'
                USING ERRCODE = '23514', CONSTRAINT = 'payment_attempts_wallet_operation_owner';
            END IF;
            IF NEW.amount > order_row.total_amount - COALESCE((
              SELECT sum(receipt.amount)
              FROM payment_attempts AS prior_attempt
              JOIN payment_receipts AS receipt ON receipt.payment_attempt_id = prior_attempt.id
              WHERE prior_attempt.order_id = order_row.id
            ), 0) THEN
              RAISE EXCEPTION 'Wallet payment cannot exceed the remaining order amount'
                USING ERRCODE = '23514', CONSTRAINT = 'payment_attempts_wallet_amount_exceeds_due';
            END IF;
          END IF;
        ELSE
          IF NEW.source <> 'external' THEN
            RAISE EXCEPTION 'Wallet top-ups require an external payment attempt'
              USING ERRCODE = '23514', CONSTRAINT = 'payment_attempts_topup_source';
          END IF;
          PERFORM id FROM customers WHERE id = NEW.topup_customer_id AND status = 'active' FOR KEY SHARE;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'Top-up target must be an active customer'
              USING ERRCODE = '23514', CONSTRAINT = 'payment_attempts_topup_customer_active';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER payment_attempts_validate BEFORE INSERT ON payment_attempts FOR EACH ROW EXECUTE FUNCTION validate_payment_attempt()`.execute(db)

    await sql`
      CREATE FUNCTION guard_payment_attempt_update() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF ROW(NEW.id, NEW.idempotency_key, NEW.request_sha256, NEW.order_id, NEW.topup_customer_id,
               NEW.source, NEW.amount, NEW.provider, NEW.provider_payment_id, NEW.wallet_operation_id, NEW.created_at)
          IS DISTINCT FROM ROW(OLD.id, OLD.idempotency_key, OLD.request_sha256, OLD.order_id, OLD.topup_customer_id,
               OLD.source, OLD.amount, OLD.provider, OLD.provider_payment_id, OLD.wallet_operation_id, OLD.created_at) THEN
          RAISE EXCEPTION 'Payment attempt identity, source and expected amount are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_attempts_identity_immutable';
        END IF;
        IF OLD.status IS DISTINCT FROM NEW.status AND NOT (
          (OLD.status = 'created' AND NEW.status IN ('pending', 'succeeded', 'failed', 'expired', 'cancelled', 'reconciliation_required'))
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
          HAVING sum(receipt.amount) = NEW.amount AND bool_and(receipt.disposition = 'on_time')
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
    await sql`CREATE TRIGGER payment_attempts_guard BEFORE UPDATE ON payment_attempts FOR EACH ROW EXECUTE FUNCTION guard_payment_attempt_update()`.execute(db)

    await sql`
      CREATE FUNCTION lock_and_classify_payment_receipt() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        attempt payment_attempts%ROWTYPE;
        order_row orders%ROWTYPE;
        prior_received numeric;
        unresolved boolean;
        ledger_amount numeric(18, 2);
      BEGIN
        SELECT * INTO attempt FROM payment_attempts WHERE id = NEW.payment_attempt_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Payment attempt does not exist'
            USING ERRCODE = '23503', CONSTRAINT = 'payment_receipts_attempt_fkey';
        END IF;
        IF attempt.order_id IS NOT NULL THEN
          SELECT * INTO order_row FROM orders WHERE id = attempt.order_id FOR UPDATE;
        ELSE
          PERFORM customer_id FROM wallet_accounts WHERE customer_id = attempt.topup_customer_id FOR UPDATE;
        END IF;
        SELECT * INTO attempt FROM payment_attempts WHERE id = NEW.payment_attempt_id FOR UPDATE;
        NEW.received_at := clock_timestamp();

        IF NEW.refund_reserved_amount <> 0 OR NEW.refunded_amount <> 0 THEN
          RAISE EXCEPTION 'Payment refund totals must begin at zero and follow refund allocations'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_receipts_initial_refund_totals';
        END IF;

        IF attempt.source = 'external' THEN
          IF NEW.source_bucket <> 'external' OR NEW.provider IS DISTINCT FROM attempt.provider
            OR NEW.provider_transaction_id IS NULL THEN
            RAISE EXCEPTION 'External payment receipt must match its provider attempt'
              USING ERRCODE = '23514', CONSTRAINT = 'payment_receipts_provider_match';
          END IF;
          IF NEW.wallet_operation_id IS NOT NULL OR NEW.wallet_line_no IS NOT NULL THEN
            RAISE EXCEPTION 'External payment receipts cannot use wallet operation references'
              USING ERRCODE = '23514', CONSTRAINT = 'payment_receipts_external_wallet_reference';
          END IF;
        ELSE
          IF NEW.source_bucket NOT IN ('cash', 'gift')
            OR NEW.provider IS NOT NULL OR NEW.provider_transaction_id IS NOT NULL
            OR NEW.wallet_operation_id IS DISTINCT FROM attempt.wallet_operation_id
            OR NEW.wallet_line_no NOT BETWEEN 1 AND 2 OR NEW.amount > attempt.amount THEN
            RAISE EXCEPTION 'Wallet receipt must match its wallet payment attempt'
              USING ERRCODE = '23514', CONSTRAINT = 'payment_receipts_wallet_match';
          END IF;
          SELECT amount INTO ledger_amount FROM wallet_ledger_entries
          WHERE wallet_operation_id = attempt.wallet_operation_id AND line_no = NEW.wallet_line_no
            AND payment_attempt_id = attempt.id AND action = 'debit_available'
            AND bucket = NEW.source_bucket;
          IF NOT FOUND OR ledger_amount <> NEW.amount THEN
            RAISE EXCEPTION 'Wallet receipt must have an equal immutable debit ledger entry'
              USING ERRCODE = '23514', CONSTRAINT = 'payment_receipts_wallet_ledger_match';
          END IF;
        END IF;

        IF attempt.status IN ('succeeded', 'late_succeeded', 'reconciliation_required')
          OR (attempt.source = 'wallet' AND attempt.status IN ('failed', 'expired', 'cancelled')) THEN
          RAISE EXCEPTION 'Payment attempt cannot accept another settlement in its current state'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_receipts_attempt_state';
        END IF;
        NEW.disposition := 'on_time';
        IF attempt.status IN ('failed', 'expired', 'cancelled') THEN
          NEW.disposition := 'late';
        END IF;
        IF attempt.order_id IS NOT NULL THEN
          IF order_row.status = 'pending_payment'
            AND (order_row.unpaid_expires_at <= clock_timestamp() OR attempt.expires_at <= clock_timestamp()) THEN
            UPDATE orders SET status = 'closed' WHERE id = order_row.id;
            order_row.status := 'closed';
          END IF;
          IF attempt.source = 'wallet' AND (order_row.status <> 'pending_payment'
            OR order_row.unpaid_expires_at <= clock_timestamp()) THEN
            RAISE EXCEPTION 'Wallet payment cannot settle a closed order'
              USING ERRCODE = '23514', CONSTRAINT = 'payment_receipts_wallet_order_open';
          END IF;
          IF order_row.status = 'closed' THEN
            NEW.disposition := 'late';
          ELSE
            SELECT COALESCE(sum(receipt.amount), 0), COALESCE(bool_or(receipt.disposition IN ('late', 'amount_mismatch', 'excess')), false)
              INTO prior_received, unresolved
            FROM payment_receipts AS receipt
            JOIN payment_attempts AS previous_attempt ON previous_attempt.id = receipt.payment_attempt_id
            WHERE previous_attempt.order_id = order_row.id;
            IF attempt.source = 'external' AND NEW.amount <> attempt.amount THEN
              NEW.disposition := 'amount_mismatch';
            ELSIF prior_received + NEW.amount > order_row.total_amount THEN
              NEW.disposition := 'excess';
            END IF;
          END IF;
        ELSIF NEW.amount <> attempt.amount THEN
          NEW.disposition := 'amount_mismatch';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER payment_receipts_lock_classify BEFORE INSERT ON payment_receipts FOR EACH ROW EXECUTE FUNCTION lock_and_classify_payment_receipt()`.execute(db)

    await sql`
      CREATE FUNCTION protect_payment_receipt() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'Payment receipts are immutable financial records'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_receipts_immutable';
        END IF;
        IF ROW(NEW.id, NEW.payment_attempt_id, NEW.source_bucket, NEW.provider,
               NEW.provider_transaction_id, NEW.wallet_operation_id, NEW.wallet_line_no,
               NEW.amount, NEW.disposition, NEW.received_at)
          IS DISTINCT FROM ROW(OLD.id, OLD.payment_attempt_id, OLD.source_bucket, OLD.provider,
               OLD.provider_transaction_id, OLD.wallet_operation_id, OLD.wallet_line_no,
               OLD.amount, OLD.disposition, OLD.received_at) THEN
          RAISE EXCEPTION 'Payment receipt identity and received amount are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_receipts_immutable';
        END IF;
        IF ROW(NEW.refund_reserved_amount, NEW.refunded_amount)
          IS DISTINCT FROM ROW(OLD.refund_reserved_amount, OLD.refunded_amount)
          AND pg_trigger_depth() < 2 THEN
          RAISE EXCEPTION 'Payment receipt refund totals are maintained by refund allocations'
            USING ERRCODE = '23514', CONSTRAINT = 'payment_receipts_refund_totals_guard';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER payment_receipts_guard BEFORE UPDATE OR DELETE ON payment_receipts FOR EACH ROW EXECUTE FUNCTION protect_payment_receipt()`.execute(db)
    await sql`CREATE TRIGGER payment_receipts_prevent_truncate BEFORE TRUNCATE ON payment_receipts FOR EACH STATEMENT EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)

    await sql`
      CREATE FUNCTION finish_payment_receipt() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        attempt payment_attempts%ROWTYPE;
        received numeric;
        unresolved boolean;
      BEGIN
        SELECT * INTO attempt FROM payment_attempts WHERE id = NEW.payment_attempt_id;
        IF attempt.source = 'wallet' THEN
          SELECT COALESCE(sum(amount), 0) INTO received
          FROM payment_receipts WHERE payment_attempt_id = NEW.payment_attempt_id;
          UPDATE payment_attempts SET
            status = CASE
              WHEN received < attempt.amount THEN 'pending'
              WHEN received = attempt.amount THEN 'succeeded'
              ELSE 'reconciliation_required' END,
            completed_at = CASE WHEN received = attempt.amount THEN now() ELSE NULL END
          WHERE id = NEW.payment_attempt_id;
        ELSE
          UPDATE payment_attempts SET
            status = CASE NEW.disposition
              WHEN 'late' THEN 'late_succeeded'
              WHEN 'amount_mismatch' THEN 'reconciliation_required'
              WHEN 'excess' THEN 'reconciliation_required'
              ELSE 'succeeded' END,
            completed_at = now()
          WHERE id = NEW.payment_attempt_id;
        END IF;

        IF attempt.topup_customer_id IS NOT NULL AND NEW.disposition = 'on_time' THEN
          INSERT INTO wallet_operations (id, customer_id, operation_type, request_sha256)
          VALUES (NEW.id, attempt.topup_customer_id, 'top_up', attempt.request_sha256);
          INSERT INTO wallet_ledger_entries (
            id, wallet_operation_id, line_no, customer_id, bucket, action, amount, payment_attempt_id
          ) VALUES (
            gen_random_uuid(), NEW.id, 1, attempt.topup_customer_id, 'cash', 'credit_available', NEW.amount, attempt.id
          );
        END IF;

        IF attempt.order_id IS NOT NULL AND NEW.disposition = 'on_time' THEN
          SELECT COALESCE(sum(receipt.amount), 0), COALESCE(bool_or(receipt.disposition IN ('late', 'amount_mismatch', 'excess')), false)
            INTO received, unresolved
          FROM payment_receipts AS receipt
          JOIN payment_attempts AS source_attempt ON source_attempt.id = receipt.payment_attempt_id
          WHERE source_attempt.order_id = attempt.order_id;
          IF received >= (SELECT total_amount FROM orders WHERE id = attempt.order_id) AND NOT unresolved
            AND (SELECT status FROM orders WHERE id = attempt.order_id) = 'pending_payment' THEN
            UPDATE orders SET status = 'processing' WHERE id = attempt.order_id;
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER payment_receipts_finish AFTER INSERT ON payment_receipts FOR EACH ROW EXECUTE FUNCTION finish_payment_receipt()`.execute(db)

    await sql`
      CREATE FUNCTION validate_refund_allocation() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        refund_row order_refunds%ROWTYPE;
        receipt payment_receipts%ROWTYPE;
        attempt payment_attempts%ROWTYPE;
        owner_customer uuid;
      BEGIN
        IF NEW.status <> 'reserved' OR NEW.completed_at IS NOT NULL THEN
          RAISE EXCEPTION 'Refund allocations must start reserved and uncompleted'
            USING ERRCODE = '23514', CONSTRAINT = 'order_refund_allocation_initial_state';
        END IF;
        SELECT * INTO refund_row FROM order_refunds WHERE id = NEW.refund_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Refund request does not exist'
            USING ERRCODE = '23503', CONSTRAINT = 'order_refund_allocations_refund_fkey';
        END IF;
        PERFORM id FROM orders WHERE id = refund_row.order_id FOR UPDATE;
        PERFORM id FROM order_refunds WHERE id = NEW.refund_id FOR UPDATE;
        SELECT * INTO receipt FROM payment_receipts WHERE id = NEW.source_payment_receipt_id FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Refund source receipt does not exist'
            USING ERRCODE = '23503', CONSTRAINT = 'order_refund_allocations_source_fkey';
        END IF;
        SELECT * INTO attempt FROM payment_attempts WHERE id = receipt.payment_attempt_id;
        IF attempt.order_id IS DISTINCT FROM refund_row.order_id THEN
          RAISE EXCEPTION 'Refund source belongs to another order'
            USING ERRCODE = '23514', CONSTRAINT = 'order_refund_source_order_match';
        END IF;
        IF refund_row.status NOT IN ('approved', 'processing', 'partially_succeeded') THEN
          RAISE EXCEPTION 'Refund allocations require an approved or processing refund'
            USING ERRCODE = '23514', CONSTRAINT = 'order_refund_allocation_state';
        END IF;
        IF NOT (
          (receipt.source_bucket = 'gift' AND NEW.destination = 'gift_balance')
          OR (receipt.source_bucket = 'cash' AND NEW.destination = 'cash_balance')
          OR (receipt.source_bucket = 'external' AND NEW.destination IN ('original_source', 'cash_balance'))
        ) THEN
          RAISE EXCEPTION 'Refund destination cannot convert gift funds into cash funds'
            USING ERRCODE = '23514', CONSTRAINT = 'order_refund_source_bucket_match';
        END IF;
        IF NEW.destination IN ('cash_balance', 'gift_balance') THEN
          SELECT customer_id INTO owner_customer FROM orders WHERE id = refund_row.order_id;
          IF owner_customer IS NULL THEN
            RAISE EXCEPTION 'Guest order refunds cannot credit a customer wallet'
              USING ERRCODE = '23514', CONSTRAINT = 'order_refund_guest_wallet_forbidden';
          END IF;
        END IF;
        IF NEW.status = 'reserved' AND NEW.provider_refund_id IS NOT NULL THEN
          RAISE EXCEPTION 'A reserved refund has not yet been confirmed by its provider'
            USING ERRCODE = '23514', CONSTRAINT = 'order_refund_provider_confirmation_required';
        END IF;
        UPDATE payment_receipts SET refund_reserved_amount = refund_reserved_amount + NEW.amount
        WHERE id = NEW.source_payment_receipt_id
          AND refund_reserved_amount + refunded_amount + NEW.amount <= amount;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Refund allocations exceed the source payment amount'
            USING ERRCODE = '23514', CONSTRAINT = 'order_refund_exceeds_source_payment';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER order_refund_allocations_reserve AFTER INSERT ON order_refund_allocations FOR EACH ROW EXECUTE FUNCTION validate_refund_allocation()`.execute(db)

    await sql`
      CREATE FUNCTION transition_refund_allocation() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        receipt payment_receipts%ROWTYPE;
        attempt payment_attempts%ROWTYPE;
        customer_uuid uuid;
        bucket_name varchar(8);
      BEGIN
        IF OLD.status = NEW.status THEN RETURN NEW; END IF;
        IF OLD.status <> 'reserved' OR NEW.status NOT IN ('succeeded', 'released') THEN
          RAISE EXCEPTION 'Refund allocation status transition is not allowed'
            USING ERRCODE = '23514', CONSTRAINT = 'order_refund_allocation_transition';
        END IF;
        SELECT * INTO receipt FROM payment_receipts WHERE id = NEW.source_payment_receipt_id;
        SELECT * INTO attempt FROM payment_attempts WHERE id = receipt.payment_attempt_id;
        UPDATE payment_receipts SET
          refund_reserved_amount = refund_reserved_amount - NEW.amount,
          refunded_amount = refunded_amount + CASE WHEN NEW.status = 'succeeded' THEN NEW.amount ELSE 0 END
        WHERE id = NEW.source_payment_receipt_id AND refund_reserved_amount >= NEW.amount;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Refund allocation was not reserved on its payment source'
            USING ERRCODE = '23514', CONSTRAINT = 'order_refund_reservation_missing';
        END IF;

        IF NEW.status = 'succeeded' AND NEW.destination IN ('cash_balance', 'gift_balance') THEN
          SELECT customer_id INTO customer_uuid FROM orders
          WHERE id = attempt.order_id AND customer_id IS NOT NULL;
          bucket_name := CASE NEW.destination WHEN 'cash_balance' THEN 'cash' ELSE 'gift' END;
          INSERT INTO wallet_operations (id, customer_id, operation_type, request_sha256)
          VALUES (NEW.operation_id, customer_uuid, 'refund', NEW.request_sha256);
          INSERT INTO wallet_ledger_entries (
            id, wallet_operation_id, line_no, customer_id, bucket, action, amount, refund_allocation_id
          ) VALUES (
            gen_random_uuid(), NEW.operation_id, 1, customer_uuid, bucket_name, 'credit_available', NEW.amount, NEW.id
          );
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER order_refund_allocations_transition AFTER UPDATE OF status ON order_refund_allocations FOR EACH ROW EXECUTE FUNCTION transition_refund_allocation()`.execute(db)
    await sql`
      CREATE FUNCTION guard_order_refund_allocation_update() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE source_provider varchar(64);
      BEGIN
        IF ROW(NEW.id, NEW.refund_id, NEW.source_payment_receipt_id, NEW.operation_id,
               NEW.request_sha256, NEW.destination, NEW.amount, NEW.created_at)
          IS DISTINCT FROM ROW(OLD.id, OLD.refund_id, OLD.source_payment_receipt_id, OLD.operation_id,
               OLD.request_sha256, OLD.destination, OLD.amount, OLD.created_at) THEN
          RAISE EXCEPTION 'Refund allocation identity, source and amount are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'order_refund_allocations_identity_immutable';
        END IF;
        IF OLD.status <> 'reserved' OR NEW.status NOT IN ('succeeded', 'released') THEN
          RAISE EXCEPTION 'Refund allocation can only leave its reserved state once'
            USING ERRCODE = '23514', CONSTRAINT = 'order_refund_allocation_transition';
        END IF;
        IF NEW.destination = 'original_source' AND NEW.status = 'succeeded' THEN
          SELECT attempt.provider INTO source_provider
          FROM order_refund_allocations AS allocation
          JOIN payment_receipts AS receipt ON receipt.id = allocation.source_payment_receipt_id
          JOIN payment_attempts AS attempt ON attempt.id = receipt.payment_attempt_id
          WHERE allocation.id = NEW.id;
          IF source_provider IS NULL OR NEW.provider IS DISTINCT FROM source_provider THEN
            RAISE EXCEPTION 'Original-source refund must match the originating payment provider'
              USING ERRCODE = '23514', CONSTRAINT = 'order_refund_provider_source_match';
          END IF;
        END IF;
        NEW.completed_at := now();
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER order_refund_allocations_guard BEFORE UPDATE ON order_refund_allocations FOR EACH ROW EXECUTE FUNCTION guard_order_refund_allocation_update()`.execute(db)
    await sql`CREATE TRIGGER order_refund_allocations_immutable BEFORE DELETE ON order_refund_allocations FOR EACH ROW EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)
    await sql`CREATE TRIGGER order_refund_allocations_prevent_truncate BEFORE TRUNCATE ON order_refund_allocations FOR EACH STATEMENT EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)

    await sql`
      CREATE FUNCTION guard_order_refund_update() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          IF NEW.status <> 'requested' THEN
            RAISE EXCEPTION 'Refund requests must start in requested state'
              USING ERRCODE = '23514', CONSTRAINT = 'order_refunds_initial_state';
          END IF;
          RETURN NEW;
        END IF;
        IF ROW(NEW.id, NEW.order_id, NEW.idempotency_key, NEW.request_sha256, NEW.amount, NEW.created_at)
          IS DISTINCT FROM ROW(OLD.id, OLD.order_id, OLD.idempotency_key, OLD.request_sha256, OLD.amount, OLD.created_at) THEN
          RAISE EXCEPTION 'Refund identity and requested amount are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'order_refunds_identity_immutable';
        END IF;
        IF OLD.status IS DISTINCT FROM NEW.status AND NOT (
          (OLD.status = 'requested' AND NEW.status IN ('approved', 'cancelled'))
          OR (OLD.status = 'approved' AND NEW.status IN ('processing', 'cancelled'))
          OR (OLD.status = 'processing' AND NEW.status IN ('partially_succeeded', 'succeeded', 'failed'))
          OR (OLD.status = 'partially_succeeded' AND NEW.status IN ('processing', 'succeeded', 'failed'))
        ) THEN
          RAISE EXCEPTION 'Illegal refund status transition: % to %', OLD.status, NEW.status
            USING ERRCODE = '23514', CONSTRAINT = 'order_refunds_status_transition';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER order_refunds_guard_update BEFORE INSERT OR UPDATE ON order_refunds FOR EACH ROW EXECUTE FUNCTION guard_order_refund_update()`.execute(db)

    await sql`
      CREATE FUNCTION assert_refund_allocation_total() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        refund_uuid uuid;
        refund_status varchar(24);
        requested numeric(18, 2);
        allocated numeric(18, 2);
        succeeded numeric(18, 2);
        reserved numeric(18, 2);
      BEGIN
        IF TG_TABLE_NAME = 'order_refunds' THEN
          refund_uuid := COALESCE(NEW.id, OLD.id);
        ELSE
          refund_uuid := COALESCE(NEW.refund_id, OLD.refund_id);
        END IF;
        SELECT status, amount INTO refund_status, requested FROM order_refunds WHERE id = refund_uuid;
        IF NOT FOUND THEN RETURN NULL; END IF;
        SELECT COALESCE(sum(amount) FILTER (WHERE status IN ('reserved', 'succeeded')), 0),
          COALESCE(sum(amount) FILTER (WHERE status = 'succeeded'), 0),
          COALESCE(sum(amount) FILTER (WHERE status = 'reserved'), 0)
          INTO allocated, succeeded, reserved
        FROM order_refund_allocations WHERE refund_id = refund_uuid;
        IF refund_status IN ('processing', 'partially_succeeded', 'succeeded') AND allocated <> requested THEN
          RAISE EXCEPTION 'Active refund allocations must equal the requested refund amount'
            USING ERRCODE = '23514', CONSTRAINT = 'order_refunds_allocations_match_amount';
        END IF;
        IF refund_status = 'succeeded' AND (succeeded <> requested OR reserved <> 0) THEN
          RAISE EXCEPTION 'Refund cannot succeed before every allocation is confirmed'
            USING ERRCODE = '23514', CONSTRAINT = 'order_refunds_success_requires_allocations';
        END IF;
        IF refund_status = 'partially_succeeded' AND (succeeded <= 0 OR succeeded >= requested) THEN
          RAISE EXCEPTION 'Partial refund status must reflect a partial confirmed amount'
            USING ERRCODE = '23514', CONSTRAINT = 'order_refunds_partial_amount_check';
        END IF;
        IF refund_status IN ('failed', 'cancelled') AND (succeeded <> 0 OR reserved <> 0) THEN
          RAISE EXCEPTION 'Failed or cancelled refunds cannot retain reserved or successful allocations'
            USING ERRCODE = '23514', CONSTRAINT = 'order_refunds_terminal_allocations';
        END IF;
        RETURN NULL;
      END;
      $$
    `.execute(db)
    await sql`CREATE CONSTRAINT TRIGGER order_refunds_allocation_total_check AFTER INSERT OR UPDATE ON order_refunds DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_refund_allocation_total()`.execute(db)
    await sql`CREATE CONSTRAINT TRIGGER order_refund_allocations_total_check AFTER INSERT OR UPDATE OR DELETE ON order_refund_allocations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_refund_allocation_total()`.execute(db)

    await sql`
      CREATE FUNCTION validate_withdrawal_operation() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.status <> 'pending_review' OR NEW.reviewed_by_admin_id IS NOT NULL OR NEW.reviewed_at IS NOT NULL THEN
          RAISE EXCEPTION 'A withdrawal must begin pending manual review'
            USING ERRCODE = '23514', CONSTRAINT = 'withdrawals_initial_review_state';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM wallet_operations AS operation
          WHERE operation.id = NEW.wallet_operation_id AND operation.customer_id = NEW.customer_id
            AND operation.operation_type = 'withdrawal_freeze'
        ) THEN
          RAISE EXCEPTION 'Withdrawal must reference its customer cash-freeze operation'
            USING ERRCODE = '23514', CONSTRAINT = 'withdrawals_freeze_operation_required';
        END IF;
        PERFORM id FROM customers WHERE id = NEW.customer_id AND status = 'active' FOR KEY SHARE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Only active customers can request withdrawals'
            USING ERRCODE = '23514', CONSTRAINT = 'withdrawals_customer_must_be_active';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER withdrawals_validate BEFORE INSERT ON withdrawals FOR EACH ROW EXECUTE FUNCTION validate_withdrawal_operation()`.execute(db)

    await sql`
      CREATE FUNCTION create_withdrawal_freeze() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO wallet_ledger_entries (
          id, wallet_operation_id, line_no, customer_id, bucket, action, amount, withdrawal_id
        ) VALUES (
          gen_random_uuid(), NEW.wallet_operation_id, 1, NEW.customer_id, 'cash', 'freeze', NEW.amount, NEW.id
        );
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER withdrawals_freeze_cash AFTER INSERT ON withdrawals FOR EACH ROW EXECUTE FUNCTION create_withdrawal_freeze()`.execute(db)

    await sql`
      CREATE FUNCTION release_withdrawal_cash() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        release_operation_id uuid;
      BEGIN
        IF OLD.status IS DISTINCT FROM NEW.status AND NEW.status IN ('rejected', 'cancelled') THEN
          release_operation_id := gen_random_uuid();
          INSERT INTO wallet_operations (id, customer_id, operation_type, request_sha256)
          VALUES (release_operation_id, NEW.customer_id, 'withdrawal_release', NEW.request_sha256);
          INSERT INTO wallet_ledger_entries (
            id, wallet_operation_id, line_no, customer_id, bucket, action, amount, withdrawal_id
          ) VALUES (
            gen_random_uuid(), release_operation_id, 1, NEW.customer_id, 'cash', 'unfreeze', NEW.amount, NEW.id
          );
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER withdrawals_release_cash AFTER UPDATE OF status ON withdrawals FOR EACH ROW EXECUTE FUNCTION release_withdrawal_cash()`.execute(db)

    await sql`
      CREATE FUNCTION guard_withdrawal_update() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF ROW(NEW.id, NEW.customer_id, NEW.idempotency_key, NEW.request_sha256, NEW.wallet_operation_id,
               NEW.amount, NEW.fee_amount, NEW.payout_amount, NEW.payout_method, NEW.recipient_snapshot, NEW.created_at)
          IS DISTINCT FROM ROW(OLD.id, OLD.customer_id, OLD.idempotency_key, OLD.request_sha256, OLD.wallet_operation_id,
               OLD.amount, OLD.fee_amount, OLD.payout_amount, OLD.payout_method, OLD.recipient_snapshot, OLD.created_at) THEN
          RAISE EXCEPTION 'Withdrawal identity, payout details and fee snapshots are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'withdrawals_identity_immutable';
        END IF;
        IF ROW(NEW.reviewed_by_admin_id, NEW.reviewed_at)
          IS DISTINCT FROM ROW(OLD.reviewed_by_admin_id, OLD.reviewed_at)
          AND NOT (OLD.status = 'pending_review' AND NEW.status IN ('pending_transfer', 'rejected')) THEN
          RAISE EXCEPTION 'Withdrawal review identity can only be set during manual review'
            USING ERRCODE = '23514', CONSTRAINT = 'withdrawals_review_identity_immutable';
        END IF;
        IF NEW.status = 'rejected' AND NEW.reviewed_by_admin_id IS NULL THEN
          RAISE EXCEPTION 'A withdrawal rejection requires a recorded administrator review'
            USING ERRCODE = '23514', CONSTRAINT = 'withdrawals_rejection_requires_reviewer';
        END IF;
        IF OLD.status IS DISTINCT FROM NEW.status AND NOT (
          (OLD.status = 'pending_review' AND NEW.status IN ('pending_transfer', 'rejected', 'cancelled'))
          OR (OLD.status = 'pending_transfer' AND NEW.status IN ('transfer_processing', 'rejected', 'cancelled'))
          OR (OLD.status = 'transfer_processing' AND NEW.status IN ('transfer_uncertain', 'pending_transfer', 'completed'))
          OR (OLD.status = 'transfer_uncertain' AND NEW.status IN ('pending_transfer', 'completed'))
        ) THEN
          RAISE EXCEPTION 'Illegal withdrawal status transition: % to %', OLD.status, NEW.status
            USING ERRCODE = '23514', CONSTRAINT = 'withdrawals_status_transition';
        END IF;
        IF OLD.status IS DISTINCT FROM NEW.status
          AND OLD.status <> 'pending_review'
          AND NEW.status IN ('pending_transfer', 'transfer_processing', 'transfer_uncertain', 'completed')
          AND pg_trigger_depth() < 2 THEN
          RAISE EXCEPTION 'Payout state changes require a recorded payout-attempt result'
            USING ERRCODE = '23514', CONSTRAINT = 'withdrawals_payout_attempt_required';
        END IF;
        IF OLD.status IS DISTINCT FROM NEW.status THEN NEW.updated_at := now(); END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER withdrawals_guard_update BEFORE UPDATE ON withdrawals FOR EACH ROW EXECUTE FUNCTION guard_withdrawal_update()`.execute(db)

    await sql`
      CREATE FUNCTION transition_withdrawal_status() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        next_status varchar(32);
      BEGIN
        IF TG_OP = 'INSERT' AND NEW.status = 'started' THEN
          UPDATE withdrawals SET status = 'transfer_processing', updated_at = now()
          WHERE id = NEW.withdrawal_id AND status = 'pending_transfer';
          IF NOT FOUND THEN
            RAISE EXCEPTION 'A payout attempt requires an approved withdrawal awaiting transfer'
              USING ERRCODE = '23514', CONSTRAINT = 'withdrawal_payout_requires_pending_transfer';
          END IF;
          RETURN NEW;
        END IF;
        IF OLD.status IS NOT DISTINCT FROM NEW.status THEN RETURN NEW; END IF;
        next_status := CASE NEW.status
          WHEN 'unknown' THEN 'transfer_uncertain'
          WHEN 'succeeded' THEN 'completed'
          WHEN 'failed' THEN 'pending_transfer'
          ELSE NULL END;
        IF next_status IS NULL THEN
          RAISE EXCEPTION 'Illegal payout attempt status transition'
            USING ERRCODE = '23514', CONSTRAINT = 'withdrawal_payout_attempt_transition';
        END IF;
        UPDATE withdrawals SET status = next_status, updated_at = now()
        WHERE id = NEW.withdrawal_id AND status IN ('transfer_processing', 'transfer_uncertain');
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Withdrawal state does not match the payout attempt result'
            USING ERRCODE = '23514', CONSTRAINT = 'withdrawal_payout_state_mismatch';
        END IF;
        IF NEW.status = 'succeeded' THEN
          INSERT INTO wallet_operations (id, customer_id, operation_type, request_sha256)
          SELECT NEW.operation_id, withdrawal.customer_id, 'withdrawal_complete', withdrawal.request_sha256
          FROM withdrawals AS withdrawal WHERE withdrawal.id = NEW.withdrawal_id;
          INSERT INTO wallet_ledger_entries (
            id, wallet_operation_id, line_no, customer_id, bucket, action, amount, withdrawal_id
          )
          SELECT gen_random_uuid(), NEW.operation_id, 1, withdrawal.customer_id, 'cash', 'debit_frozen', withdrawal.amount, withdrawal.id
          FROM withdrawals AS withdrawal WHERE withdrawal.id = NEW.withdrawal_id;
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER withdrawal_payout_attempts_transition AFTER INSERT OR UPDATE OF status ON withdrawal_payout_attempts FOR EACH ROW EXECUTE FUNCTION transition_withdrawal_status()`.execute(db)

    await sql`
      CREATE FUNCTION protect_withdrawal_payout_attempt() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'Withdrawal payout attempts are permanent financial records'
            USING ERRCODE = '23514', CONSTRAINT = 'withdrawal_payout_attempts_immutable';
        END IF;
        IF TG_OP = 'INSERT' THEN
          IF NEW.status <> 'started' OR NEW.completed_at IS NOT NULL
            OR NEW.resolved_by_admin_id IS NOT NULL OR NEW.result_sha256 IS NOT NULL THEN
            RAISE EXCEPTION 'A payout attempt must start without a claimed result'
              USING ERRCODE = '23514', CONSTRAINT = 'withdrawal_payout_attempts_initial_state';
          END IF;
          RETURN NEW;
        END IF;
        IF ROW(NEW.id, NEW.withdrawal_id, NEW.operation_id, NEW.started_by_admin_id,
               NEW.provider_reference, NEW.created_at)
          IS DISTINCT FROM ROW(OLD.id, OLD.withdrawal_id, OLD.operation_id, OLD.started_by_admin_id,
               OLD.provider_reference, OLD.created_at) THEN
          RAISE EXCEPTION 'Withdrawal payout attempt identity is immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'withdrawal_payout_attempts_identity_immutable';
        END IF;
        IF OLD.status IS DISTINCT FROM NEW.status AND NOT (
          (OLD.status = 'started' AND NEW.status IN ('unknown', 'succeeded', 'failed'))
          OR (OLD.status = 'unknown' AND NEW.status IN ('succeeded', 'failed'))
        ) THEN
          RAISE EXCEPTION 'Illegal payout attempt transition: % to %', OLD.status, NEW.status
            USING ERRCODE = '23514', CONSTRAINT = 'withdrawal_payout_attempt_transition';
        END IF;
        IF ROW(NEW.resolved_by_admin_id, NEW.result_sha256)
          IS DISTINCT FROM ROW(OLD.resolved_by_admin_id, OLD.result_sha256)
          AND NOT (OLD.status IN ('started', 'unknown') AND NEW.status IN ('succeeded', 'failed')) THEN
          RAISE EXCEPTION 'Payout result evidence can only be recorded with a confirmed result'
            USING ERRCODE = '23514', CONSTRAINT = 'withdrawal_payout_result_evidence_transition';
        END IF;
        IF NEW.status IN ('succeeded', 'failed')
          AND (NEW.resolved_by_admin_id IS NULL OR NEW.result_sha256 IS NULL) THEN
          RAISE EXCEPTION 'A payout result requires an administrator and evidence digest'
            USING ERRCODE = '23514', CONSTRAINT = 'withdrawal_payout_result_requires_evidence';
        END IF;
        IF OLD.status IS NOT DISTINCT FROM NEW.status THEN
          IF NEW.completed_at IS DISTINCT FROM OLD.completed_at THEN
            RAISE EXCEPTION 'Payout attempt completion time is controlled by its result'
              USING ERRCODE = '23514', CONSTRAINT = 'withdrawal_payout_attempts_completed_at_guard';
          END IF;
        ELSE
          NEW.completed_at := now();
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER withdrawal_payout_attempts_guard BEFORE INSERT OR UPDATE OR DELETE ON withdrawal_payout_attempts FOR EACH ROW EXECUTE FUNCTION protect_withdrawal_payout_attempt()`.execute(db)
    await sql`CREATE TRIGGER withdrawal_payout_attempts_prevent_truncate BEFORE TRUNCATE ON withdrawal_payout_attempts FOR EACH STATEMENT EXECUTE FUNCTION protect_immutable_trade_history()`.execute(db)

    await sql`
      CREATE FUNCTION guard_order_fulfillment_attempt() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        item order_items%ROWTYPE;
        order_state varchar(24);
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
          OR (OLD.status = 'unknown' AND NEW.status IN ('succeeded', 'failed'))
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
    await sql`CREATE TRIGGER order_item_fulfillment_attempts_guard BEFORE INSERT OR UPDATE OR DELETE ON order_item_fulfillment_attempts FOR EACH ROW EXECUTE FUNCTION guard_order_fulfillment_attempt()`.execute(db)

    await sql`
      CREATE FUNCTION apply_order_fulfillment_attempt() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        current_item order_items%ROWTYPE;
        next_fulfilled integer;
        next_reserved integer;
        next_status varchar(24);
        parent_order uuid;
      BEGIN
        IF TG_OP = 'INSERT' THEN
          UPDATE order_items SET
            fulfillment_reserved_quantity = fulfillment_reserved_quantity + NEW.quantity,
            fulfillment_status = 'processing'
          WHERE id = NEW.order_item_id;
          RETURN NEW;
        END IF;
        IF OLD.status IS NOT DISTINCT FROM NEW.status THEN RETURN NEW; END IF;
        SELECT * INTO current_item FROM order_items WHERE id = NEW.order_item_id FOR UPDATE;
        next_fulfilled := current_item.fulfilled_quantity;
        next_reserved := current_item.fulfillment_reserved_quantity;
        IF OLD.status IN ('processing', 'unknown') AND NEW.status = 'succeeded' THEN
          next_fulfilled := next_fulfilled + NEW.quantity;
          next_reserved := next_reserved - NEW.quantity;
          IF current_item.inventory_mode_snapshot = 'quantity' THEN
            INSERT INTO order_inventory_events (
              id, reservation_id, operation_id, action, quantity
            )
            SELECT gen_random_uuid(), reservation.id, NEW.operation_id, 'consume', NEW.quantity
            FROM order_inventory_reservations AS reservation WHERE reservation.order_item_id = NEW.order_item_id;
          END IF;
        ELSIF OLD.status = 'processing' AND NEW.status = 'failed' OR OLD.status = 'unknown' AND NEW.status = 'failed' THEN
          next_reserved := next_reserved - NEW.quantity;
        END IF;

        next_status := CASE
          WHEN next_fulfilled = current_item.quantity THEN 'completed'
          WHEN NEW.status = 'unknown' THEN 'unknown'
          WHEN NEW.status = 'failed' AND next_fulfilled > 0 THEN 'partially_fulfilled'
          WHEN NEW.status = 'failed' THEN 'failed'
          WHEN next_fulfilled > 0 THEN 'partially_fulfilled'
          WHEN next_reserved > 0 THEN 'processing'
          ELSE 'pending' END;
        UPDATE order_items SET
          fulfilled_quantity = next_fulfilled,
          fulfillment_reserved_quantity = next_reserved,
          fulfillment_status = next_status
        WHERE id = NEW.order_item_id;

        SELECT order_id INTO parent_order FROM order_items WHERE id = NEW.order_item_id;
        IF NEW.status = 'failed' AND (SELECT status FROM orders WHERE id = parent_order) = 'closed'
          AND next_reserved = 0 AND current_item.inventory_mode_snapshot = 'quantity' THEN
          INSERT INTO order_inventory_events (id, reservation_id, operation_id, action, quantity)
          SELECT gen_random_uuid(), reservation.id, gen_random_uuid(), 'release', remaining.quantity::integer
          FROM order_inventory_reservations AS reservation
          CROSS JOIN LATERAL (
            SELECT COALESCE(sum(quantity) FILTER (WHERE action = 'reserve'), 0)
              - COALESCE(sum(quantity) FILTER (WHERE action IN ('release', 'consume')), 0) AS quantity
            FROM order_inventory_events WHERE reservation_id = reservation.id
          ) AS remaining
          WHERE reservation.order_item_id = NEW.order_item_id AND remaining.quantity > 0
            ;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM order_items WHERE order_id = parent_order
            AND (fulfillment_status <> 'completed' OR fulfilled_quantity <> quantity)
        ) THEN
          UPDATE orders SET status = 'completed' WHERE id = parent_order AND status = 'processing';
        END IF;
        RETURN NEW;
      END;
      $$
    `.execute(db)
    await sql`CREATE TRIGGER order_item_fulfillment_attempts_apply AFTER INSERT OR UPDATE OF status ON order_item_fulfillment_attempts FOR EACH ROW EXECUTE FUNCTION apply_order_fulfillment_attempt()`.execute(db)

    await sql`
      CREATE VIEW order_financial_status AS
      WITH paid AS (
        SELECT attempt.order_id, sum(receipt.amount) AS paid_amount,
          bool_or(receipt.disposition = 'late') AS has_late_receipt,
          bool_or(receipt.disposition = 'amount_mismatch') AS has_mismatch
        FROM payment_attempts AS attempt
        JOIN payment_receipts AS receipt ON receipt.payment_attempt_id = attempt.id
        WHERE attempt.order_id IS NOT NULL
        GROUP BY attempt.order_id
      ), refunded AS (
        SELECT refund.order_id,
          sum(allocation.amount) FILTER (WHERE allocation.status = 'succeeded') AS refunded_amount,
          sum(allocation.amount) FILTER (WHERE allocation.status = 'reserved') AS refund_in_progress_amount
        FROM order_refunds AS refund
        JOIN order_refund_allocations AS allocation ON allocation.refund_id = refund.id
        GROUP BY refund.order_id
      )
      SELECT order_row.id AS order_id, order_row.status AS order_status,
        order_row.total_amount,
        COALESCE(paid.paid_amount, 0) AS paid_amount,
        COALESCE(refunded.refunded_amount, 0) AS refunded_amount,
        COALESCE(refunded.refund_in_progress_amount, 0) AS refund_in_progress_amount,
        CASE
          WHEN order_row.total_amount = 0 THEN 'not_required'
          WHEN COALESCE(refunded.refunded_amount, 0) >= COALESCE(paid.paid_amount, 0)
            AND COALESCE(paid.paid_amount, 0) > 0 THEN 'refunded'
          WHEN COALESCE(refunded.refunded_amount, 0) > 0 THEN 'partially_refunded'
          WHEN COALESCE(paid.has_late_receipt, false) THEN 'late_paid'
          WHEN COALESCE(paid.has_mismatch, false) THEN 'requires_reconciliation'
          WHEN COALESCE(paid.paid_amount, 0) = 0 THEN 'unpaid'
          WHEN COALESCE(paid.paid_amount, 0) > order_row.total_amount THEN 'overpaid'
          WHEN COALESCE(paid.paid_amount, 0) < order_row.total_amount THEN 'partially_paid'
          ELSE 'paid'
        END AS payment_status,
        CASE
          WHEN COALESCE(refunded.refunded_amount, 0) >= COALESCE(paid.paid_amount, 0)
            AND COALESCE(refunded.refunded_amount, 0) > 0 THEN 'refunded'
          WHEN COALESCE(refunded.refund_in_progress_amount, 0) > 0 THEN 'processing'
          WHEN COALESCE(refunded.refunded_amount, 0) > 0 THEN 'partially_refunded'
          WHEN EXISTS (SELECT 1 FROM order_refunds AS pending WHERE pending.order_id = order_row.id
            AND pending.status IN ('requested', 'approved', 'processing', 'partially_succeeded')) THEN 'requested_or_processing'
          ELSE 'none'
        END AS refund_status
      FROM orders AS order_row
      LEFT JOIN paid ON paid.order_id = order_row.id
      LEFT JOIN refunded ON refunded.order_id = order_row.id
    `.execute(db)
    await sql`
      CREATE VIEW customer_order_status AS
      SELECT order_row.id AS order_id,
        CASE
          WHEN financial.payment_status = 'refunded' THEN 'refunded'
          WHEN order_row.status = 'closed' THEN 'closed'
          WHEN order_row.status = 'completed' THEN 'completed'
          WHEN order_row.status = 'pending_payment' THEN 'pending_payment'
          WHEN NOT EXISTS (SELECT 1 FROM order_items AS item WHERE item.order_id = order_row.id
            AND item.fulfillment_status <> 'pending') THEN 'awaiting_fulfillment'
          ELSE 'in_progress'
        END AS customer_status
      FROM orders AS order_row
      JOIN order_financial_status AS financial ON financial.order_id = order_row.id
    `.execute(db)
  },

  async down(db) {
    await sql`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM orders) OR EXISTS (SELECT 1 FROM customers)
          OR EXISTS (SELECT 1 FROM product_variant_fulfillment) THEN
          RAISE EXCEPTION 'Cannot remove trade foundation while customer, fulfillment, or order data exists'
            USING ERRCODE = '23514', CONSTRAINT = 'trade_foundation_data_present';
        END IF;
      END;
      $$
    `.execute(db)
    await sql`DROP TRIGGER quantity_inventory_reserved_guard ON product_variant_quantity_inventory`.execute(db)
    await sql`DROP TRIGGER products_order_type_immutable ON products`.execute(db)
    await sql`DROP VIEW customer_order_status`.execute(db)
    await sql`DROP VIEW order_financial_status`.execute(db)
    await sql`DROP TABLE order_status_events`.execute(db)
    await sql`DROP TABLE order_item_fulfillment_attempts`.execute(db)
    await sql`DROP TABLE withdrawal_payout_attempts`.execute(db)
    await sql`DROP TABLE withdrawals`.execute(db)
    await sql`DROP TABLE wallet_ledger_entries`.execute(db)
    await sql`DROP TABLE order_refund_allocations`.execute(db)
    await sql`DROP TABLE order_refunds`.execute(db)
    await sql`DROP TABLE payment_receipts`.execute(db)
    await sql`DROP TABLE payment_attempts`.execute(db)
    await sql`DROP TABLE wallet_operations`.execute(db)
    await sql`DROP TABLE wallet_accounts`.execute(db)
    await sql`DROP TABLE order_inventory_events`.execute(db)
    await sql`DROP TABLE order_inventory_reservations`.execute(db)
    await sql`DROP TABLE order_items`.execute(db)
    await sql`DROP TABLE orders`.execute(db)
    await sql`DROP TABLE product_variant_fulfillment`.execute(db)
    await sql`DROP TABLE guest_order_sessions`.execute(db)
    await sql`DROP TABLE customers`.execute(db)
    await sql`DROP TABLE storefront_customer_policy`.execute(db)
    await sql`DROP FUNCTION apply_order_fulfillment_attempt()`.execute(db)
    await sql`DROP FUNCTION guard_order_fulfillment_attempt()`.execute(db)
    await sql`DROP FUNCTION assert_wallet_operation_entries()`.execute(db)
    await sql`DROP FUNCTION validate_withdrawal_operation()`.execute(db)
    await sql`DROP FUNCTION release_withdrawal_cash()`.execute(db)
    await sql`DROP FUNCTION protect_withdrawal_payout_attempt()`.execute(db)
    await sql`DROP FUNCTION transition_withdrawal_status()`.execute(db)
    await sql`DROP FUNCTION guard_withdrawal_update()`.execute(db)
    await sql`DROP FUNCTION create_withdrawal_freeze()`.execute(db)
    await sql`DROP FUNCTION assert_refund_allocation_total()`.execute(db)
    await sql`DROP FUNCTION guard_order_refund_update()`.execute(db)
    await sql`DROP FUNCTION guard_order_refund_allocation_update()`.execute(db)
    await sql`DROP FUNCTION transition_refund_allocation()`.execute(db)
    await sql`DROP FUNCTION validate_refund_allocation()`.execute(db)
    await sql`DROP FUNCTION finish_payment_receipt()`.execute(db)
    await sql`DROP FUNCTION protect_payment_receipt()`.execute(db)
    await sql`DROP FUNCTION lock_and_classify_payment_receipt()`.execute(db)
    await sql`DROP FUNCTION validate_payment_attempt()`.execute(db)
    await sql`DROP FUNCTION record_order_status_event()`.execute(db)
    await sql`DROP FUNCTION release_order_inventory_on_close()`.execute(db)
    await sql`DROP FUNCTION apply_order_inventory_event()`.execute(db)
    await sql`DROP FUNCTION create_initial_inventory_reservation_event()`.execute(db)
    await sql`DROP FUNCTION assert_order_amount_and_inventory_for_items(uuid)`.execute(db)
    await sql`DROP FUNCTION assert_order_item_inventory(uuid, uuid)`.execute(db)
    await sql`DROP FUNCTION assert_order_amount_and_inventory()`.execute(db)
    await sql`DROP FUNCTION protect_order_item_snapshot()`.execute(db)
    await sql`DROP FUNCTION validate_order_item_snapshot()`.execute(db)
    await sql`DROP FUNCTION guard_order_update()`.execute(db)
    await sql`DROP FUNCTION validate_new_order()`.execute(db)
    await sql`DROP FUNCTION apply_wallet_ledger_entry()`.execute(db)
    await sql`DROP FUNCTION protect_immutable_trade_history()`.execute(db)
    await sql`DROP FUNCTION guard_wallet_account_balance_write()`.execute(db)
    await sql`DROP FUNCTION guard_reserved_inventory_write()`.execute(db)
    await sql`DROP FUNCTION guard_payment_attempt_update()`.execute(db)
    await sql`DROP FUNCTION prevent_customer_resurrection()`.execute(db)
    await sql`DROP FUNCTION enforce_customer_policy()`.execute(db)
    await sql`DROP FUNCTION create_customer_wallet_account()`.execute(db)
    await sql`DROP FUNCTION forbid_ordered_product_type_change()`.execute(db)
  },
}
