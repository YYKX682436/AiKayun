import { Pool } from 'pg'

const skuId = process.argv[2]
if (!skuId || !/^[0-9a-f-]{36}$/iu.test(skuId)) throw new Error('A test SKU UUID is required')
const connectionString = process.env.TEST_DATABASE_URL
if (!connectionString || !new URL(connectionString).pathname.endsWith('_test')) {
  throw new Error('The checkout fixture requires a dedicated _test database')
}
const pool = new Pool({ connectionString, max: 1 })
try {
  const result = await pool.query(`
    SELECT DISTINCT o.id, o.idempotency_key
    FROM orders o JOIN order_items i ON i.order_id = o.id
    WHERE i.product_variant_id = $1 ORDER BY o.id
  `, [skuId])
  process.stdout.write(JSON.stringify(result.rows))
} finally {
  await pool.end()
}
