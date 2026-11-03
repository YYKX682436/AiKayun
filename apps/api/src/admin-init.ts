import { createDatabase } from './db/pool.js'
import { initializeAdminThroughCli } from './auth/initial-admin.js'

const configuredEmail = process.env.ADMIN_INITIAL_EMAIL
const password = process.env.ADMIN_INITIAL_PASSWORD

if (!configuredEmail) throw new Error('Set ADMIN_INITIAL_EMAIL to a valid email address')
if (!password) throw new Error('Set ADMIN_INITIAL_PASSWORD to a unique password of at least 14 characters')
const db = createDatabase()
try {
  const administrator = await initializeAdminThroughCli(db, configuredEmail, password)
  console.info(`Initialized administrator ${administrator.email}`)
} finally {
  await db.destroy()
}
