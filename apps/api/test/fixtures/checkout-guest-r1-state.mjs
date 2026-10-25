import { Pool } from 'pg'

const key = process.argv[2]
if (!key || !/^[0-9a-f-]{36}$/iu.test(key)) throw new Error('A test order UUID is required')
const connectionString = process.env.TEST_DATABASE_URL
if (!connectionString || !new URL(connectionString).pathname.endsWith('_test')) {
  throw new Error('The checkout fixture requires a dedicated _test database')
}
const pool = new Pool({ connectionString, max: 1 })
try {
  const orders = await pool.query('SELECT id, guest_order_session_id FROM orders WHERE idempotency_key = $1', [key])
  const reservations = await pool.query(`
    SELECT r.id, r.quantity FROM order_inventory_reservations r
    JOIN order_items i ON i.id = r.order_item_id JOIN orders o ON o.id = i.order_id
    WHERE o.idempotency_key = $1
  `, [key])
  process.stdout.write(JSON.stringify({ orders: orders.rows, reservations: reservations.rows }))
} finally {
  await pool.end()
}
