-- Read-only, repeatable audit. Run in REPEATABLE READ READ ONLY.
-- Optional SET LOCAL aikayun.reconcile_skus = '<uuid>,<uuid>' limits the audit.
-- Quantity inventories created through the supported API start at zero.
-- Imported opening stock requires its original adjustment history; this query
-- deliberately reports unexplained quantities instead of repairing balances.
WITH scoped_items AS (
  SELECT item.*, parent.status AS order_status FROM order_items AS item
  JOIN orders AS parent ON parent.id = item.order_id
  WHERE COALESCE(current_setting('aikayun.reconcile_skus', true), '') = ''
    OR item.product_variant_id::text = ANY(string_to_array(current_setting('aikayun.reconcile_skus', true), ','))
), scoped_skus AS (
  SELECT variant.* FROM product_variants AS variant
  WHERE COALESCE(current_setting('aikayun.reconcile_skus', true), '') = ''
    OR variant.id::text = ANY(string_to_array(current_setting('aikayun.reconcile_skus', true), ','))
), attempts AS (
  SELECT order_item_id,
    COALESCE(sum(quantity) FILTER (WHERE status = 'succeeded'), 0) AS succeeded,
    COALESCE(sum(quantity) FILTER (WHERE status IN ('processing', 'unknown')), 0) AS active
  FROM order_item_fulfillment_attempts GROUP BY order_item_id
), delivered AS (
  SELECT attempt.order_item_id, count(*) AS units, count(DISTINCT delivery.unit_index) AS distinct_units
  FROM order_item_fulfillment_deliveries AS delivery
  JOIN order_item_fulfillment_attempts AS attempt ON attempt.id = delivery.fulfillment_attempt_id
  WHERE attempt.status = 'succeeded' GROUP BY attempt.order_item_id
), events AS (
  SELECT reservation.order_item_id, reservation.product_variant_id,
    sum(event.quantity) FILTER (WHERE event.action = 'reserve') AS reserved,
    COALESCE(sum(event.quantity) FILTER (WHERE event.action = 'consume'), 0) AS consumed,
    COALESCE(sum(event.quantity) FILTER (WHERE event.action = 'release'), 0) AS released
  FROM order_inventory_reservations AS reservation
  LEFT JOIN order_inventory_events AS event ON event.reservation_id = reservation.id
  GROUP BY reservation.order_item_id, reservation.product_variant_id
), stock_movements AS (
  SELECT product_variant_id, sum(quantity_delta) AS delta FROM product_variant_inventory_adjustments GROUP BY product_variant_id
), pool_movements AS (
  SELECT product_variant_id, COALESCE(sum(CASE action WHEN 'restock' THEN quantity WHEN 'withdraw' THEN -quantity ELSE 0 END), 0) AS delta
  FROM order_inventory_events WHERE product_variant_id IS NOT NULL GROUP BY product_variant_id
), stock_events AS (
  SELECT product_variant_id, sum(reserved - consumed - released) AS reserved, sum(consumed) AS consumed
  FROM events GROUP BY product_variant_id
), pool_consumptions AS (
  SELECT item.product_variant_id, sum(event.consumed) AS consumed
  FROM events AS event JOIN order_items AS item ON item.id = event.order_item_id
  WHERE item.fulfillment_method_snapshot = 'code_pool' GROUP BY item.product_variant_id
), pool AS (
  SELECT product_variant_id, count(*) FILTER (WHERE state = 'available') AS available,
    count(*) FILTER (WHERE state = 'reserved') AS reserved,
    count(*) FILTER (WHERE state = 'delivered') AS delivered
  FROM code_pool_entries GROUP BY product_variant_id
), checks AS (
  SELECT 'item_success' AS check_name, item.id AS entity_id, COALESCE(attempt.succeeded, 0) AS expected, item.fulfilled_quantity::bigint AS actual
  FROM scoped_items AS item LEFT JOIN attempts AS attempt ON attempt.order_item_id = item.id
  UNION ALL
  SELECT 'item_active', item.id, COALESCE(attempt.active, 0), item.fulfillment_reserved_quantity
  FROM scoped_items AS item LEFT JOIN attempts AS attempt ON attempt.order_item_id = item.id
  UNION ALL
  SELECT 'delivery_count', item.id, item.fulfilled_quantity, COALESCE(delivery.units, 0)
  FROM scoped_items AS item LEFT JOIN delivered AS delivery ON delivery.order_item_id = item.id
  UNION ALL
  SELECT 'delivery_unique_units', item.id, COALESCE(delivery.units, 0), COALESCE(delivery.distinct_units, 0)
  FROM scoped_items AS item LEFT JOIN delivered AS delivery ON delivery.order_item_id = item.id
  UNION ALL
  SELECT 'reservation_quantity', item.id, CASE WHEN item.inventory_mode_snapshot = 'quantity' THEN item.quantity ELSE 0 END, COALESCE(event.reserved, 0)
  FROM scoped_items AS item LEFT JOIN events AS event ON event.order_item_id = item.id
  UNION ALL
  SELECT 'consumed_units', item.id, CASE WHEN item.inventory_mode_snapshot = 'quantity' THEN item.fulfilled_quantity ELSE 0 END, COALESCE(event.consumed, 0)
  FROM scoped_items AS item LEFT JOIN events AS event ON event.order_item_id = item.id
  UNION ALL
  SELECT 'remaining_reservation', item.id,
    CASE WHEN item.inventory_mode_snapshot = 'quantity' AND item.order_status <> 'closed' THEN item.quantity - item.fulfilled_quantity ELSE 0 END,
    COALESCE(event.reserved - event.consumed - event.released, 0)
  FROM scoped_items AS item LEFT JOIN events AS event ON event.order_item_id = item.id
  UNION ALL
  SELECT 'inventory_reserved', variant.id, COALESCE(event.reserved, 0), inventory.reserved
  FROM scoped_skus AS variant JOIN product_variant_quantity_inventory AS inventory ON inventory.product_variant_id = variant.id
  LEFT JOIN stock_events AS event ON event.product_variant_id = variant.id
  UNION ALL
  SELECT 'inventory_stocked', variant.id, COALESCE(adjustment.delta, 0) + COALESCE(movement.delta, 0) - COALESCE(event.consumed, 0), inventory.stocked
  FROM scoped_skus AS variant JOIN product_variant_quantity_inventory AS inventory ON inventory.product_variant_id = variant.id
  LEFT JOIN stock_movements AS adjustment ON adjustment.product_variant_id = variant.id
  LEFT JOIN pool_movements AS movement ON movement.product_variant_id = variant.id
  LEFT JOIN stock_events AS event ON event.product_variant_id = variant.id
  UNION ALL
  SELECT 'pool_reserved', variant.id, COALESCE(pool.reserved, 0), inventory.reserved
  FROM scoped_skus AS variant JOIN product_variant_fulfillment AS config ON config.product_variant_id = variant.id AND config.method = 'code_pool'
  JOIN product_variant_quantity_inventory AS inventory ON inventory.product_variant_id = variant.id LEFT JOIN pool ON pool.product_variant_id = variant.id
  UNION ALL
  SELECT 'pool_sellable', variant.id, COALESCE(pool.available, 0), inventory.stocked - inventory.reserved
  FROM scoped_skus AS variant JOIN product_variant_fulfillment AS config ON config.product_variant_id = variant.id AND config.method = 'code_pool'
  JOIN product_variant_quantity_inventory AS inventory ON inventory.product_variant_id = variant.id LEFT JOIN pool ON pool.product_variant_id = variant.id
  UNION ALL
  SELECT 'pool_delivered', variant.id, COALESCE(pool.delivered, 0), COALESCE(event.consumed, 0)
  FROM scoped_skus AS variant LEFT JOIN pool ON pool.product_variant_id = variant.id
  LEFT JOIN pool_consumptions AS event ON event.product_variant_id = variant.id
  WHERE pool.product_variant_id IS NOT NULL OR event.product_variant_id IS NOT NULL
)
SELECT check_name, entity_id, expected::text, actual::text FROM checks WHERE expected IS DISTINCT FROM actual ORDER BY check_name, entity_id;
