import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

/** Create an admin session through the API's isolated PostgreSQL fixture helper. */
export function createBrowserAdminSession(): string {
  const workspaceRoot = resolve(import.meta.dirname, '../../../..')
  const token = execFileSync(
    'pnpm',
    ['--filter', '@aikayun/api', 'exec', 'node', 'test/browser-admin-session.mjs'],
    { cwd: workspaceRoot, env: process.env, encoding: 'utf8' },
  ).trim()
  if (!token) throw new Error('The E2E administrator session fixture returned no token')
  return token
}
