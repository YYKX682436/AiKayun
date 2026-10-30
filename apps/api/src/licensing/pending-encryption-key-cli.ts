import { isAbsolute } from 'node:path'
import { readConfig } from '../config.js'
import { initializeTemporaryLicensePendingKey, LicensePendingKeyError } from './pending-encryption-key.js'

export interface PendingKeyCliArguments {
  temporary: true
  environment: 'development' | 'test'
  root: string
}

export function parsePendingKeyCliArguments(values: string[]): PendingKeyCliArguments {
  if (values[0] !== 'init') throw new Error('Usage: license-pending-key init --temporary --environment development|test --pending-key-dir ABSOLUTE_PATH')
  let temporary = false
  let environment: 'development' | 'test' | undefined
  let root: string | undefined
  for (let index = 1; index < values.length; index += 1) {
    const value = values[index]
    if (value === '--temporary' && !temporary) {
      temporary = true
      continue
    }
    if (value === '--environment' && !environment) {
      const selected = values[index + 1]
      if (selected !== 'development' && selected !== 'test') throw new Error('--environment must be development or test')
      environment = selected
      index += 1
      continue
    }
    if (value === '--pending-key-dir' && !root) {
      const selected = values[index + 1]
      if (!selected || !isAbsolute(selected)) throw new Error('--pending-key-dir requires an absolute path')
      root = selected
      index += 1
      continue
    }
    throw new Error('Unsupported or duplicate license pending key argument')
  }
  if (!temporary || !environment || !root) throw new Error('Temporary key initialization requires --temporary, --environment and --pending-key-dir')
  return { temporary: true, environment, root }
}

export async function runPendingKeyCli(args: PendingKeyCliArguments, nodeEnv: string, testDatabaseUrl?: string): Promise<void> {
  if (nodeEnv !== args.environment || (nodeEnv !== 'development' && nodeEnv !== 'test')) {
    throw new LicensePendingKeyError('temporary_pending_key_environment_mismatch')
  }
  if (nodeEnv === 'test') {
    let databaseName = ''
    try { databaseName = new URL(testDatabaseUrl ?? '').pathname.slice(1) } catch { /* fail closed below */ }
    if (!databaseName.endsWith('_test')) throw new LicensePendingKeyError('temporary_pending_key_test_database_required')
  }
  const config = readConfig(process.env)
  const created = await initializeTemporaryLicensePendingKey(args.root, nodeEnv, [
    config.mediaRoot,
    config.privateFileRoot,
    config.identityRoot,
    config.licenseTrustStoreRoot,
  ])
  void created
}

async function main(): Promise<void> {
  try {
    const args = parsePendingKeyCliArguments(process.argv.slice(2))
    await runPendingKeyCli(args, process.env.NODE_ENV ?? '', process.env.TEST_DATABASE_URL)
    process.stdout.write('Temporary license pending key initialized.\n')
  } catch (error) {
    const code = error instanceof LicensePendingKeyError ? error.code : 'pending_key_cli_invalid'
    process.stderr.write(`${JSON.stringify({ status: 'error', code })}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main()
