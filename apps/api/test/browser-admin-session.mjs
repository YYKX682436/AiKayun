import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'

/** Creates a real admin session for UI fixture setup without consuming the login rate limit. */
export async function createBrowserAdminSession() {
  const databaseUrl = process.env.TEST_DATABASE_URL
    ?? 'postgresql://aikayun:local-test-password@127.0.0.1:5432/aikayun_test'
  const databaseName = new URL(databaseUrl).pathname.slice(1)
  if (!databaseName.endsWith('_test')) {
    throw new Error('Browser admin fixtures require a PostgreSQL database ending in _test')
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 1 })
  try {
    const admin = await pool.query(
      'SELECT id FROM admin_users WHERE email = $1 AND is_active = true',
      ['browser-test@example.com'],
    )
    const adminId = admin.rows[0]?.id
    if (!adminId) throw new Error('The E2E administrator fixture is missing')

    const token = randomBytes(32).toString('base64url')
    const tokenHash = createHash('sha256').update(token).digest('hex')
    await pool.query(
      'INSERT INTO admin_sessions (id, admin_user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)',
      [randomUUID(), adminId, tokenHash, new Date(Date.now() + 60 * 60 * 1000)],
    )
    return token
  }
  finally {
    await pool.end()
  }
}
