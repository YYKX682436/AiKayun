import { createDatabase } from './db/pool.js'
import { issueInitialSetupToken } from './auth/initial-admin.js'

async function main(): Promise<void> {
  if (process.env.NODE_ENV !== 'production') {
    throw new Error('setup_token_cli_requires_NODE_ENV_production')
  }
  if (process.argv.length !== 3 || process.argv[2] !== 'issue') {
    throw new Error('Usage: setup-token issue')
  }
  const db = createDatabase()
  try {
    const result = await issueInitialSetupToken(db)
    if (result.status === 'completed') {
      process.stdout.write('Initial setup is already complete. No token was created.\n')
      return
    }
    process.stdout.write(`One-time setup token (valid until ${result.expiresAt}):\n${result.token}\n`)
  } finally {
    await db.destroy()
  }
}

try {
  await main()
} catch (error) {
  const code = error instanceof Error && /^[a-z][a-z0-9_]{1,96}$/u.test(error.message)
    ? error.message
    : 'setup_token_issue_failed'
  process.stderr.write(`${JSON.stringify({ status: 'error', code })}\n`)
  process.exitCode = 1
}
