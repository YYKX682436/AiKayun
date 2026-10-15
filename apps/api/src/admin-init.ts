import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { createDatabase } from './db/pool.js'
import { hashPassword } from './auth/password.js'

const email = process.env.ADMIN_INITIAL_EMAIL?.trim().toLowerCase()
const password = process.env.ADMIN_INITIAL_PASSWORD

if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  throw new Error('Set ADMIN_INITIAL_EMAIL to a valid email address')
}
if (!password || password.length < 14 || password.length > 1024) {
  throw new Error('Set ADMIN_INITIAL_PASSWORD to a unique password of at least 14 characters')
}
if (password.toLowerCase().includes(email.split('@')[0] ?? '')) {
  throw new Error('The administrator password must not contain the email name')
}

const db = createDatabase()
try {
  const passwordHash = await hashPassword(password)
  await db.transaction().execute(async (transaction) => {
    await sql`select pg_advisory_xact_lock(hashtext('aikayun:admin:init'))`.execute(transaction)
    const adminCount = await transaction.selectFrom('admin_users')
      .select((expression) => expression.fn.countAll<number>().as('count'))
      .executeTakeFirstOrThrow()
    if (Number(adminCount.count) > 0) {
      throw new Error('An administrator already exists; initial setup is one-time only')
    }

    await transaction.insertInto('admin_users').values({
      id: randomUUID(),
      email,
      password_hash: passwordHash,
    }).execute()
  })
  console.info(`Initialized administrator ${email}`)
} finally {
  await db.destroy()
}
