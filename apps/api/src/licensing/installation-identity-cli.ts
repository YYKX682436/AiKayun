import type { AppConfig } from '../config.js'
import type { Pool } from 'pg'
import {
  initializeInstallationIdentity,
  InstallationIdentityError,
  verifyInstallationIdentity,
  type InstallationInitializationMode,
} from './installation-identity.js'

export interface IdentityCliArguments {
  command: 'init' | 'verify'
  mode?: InstallationInitializationMode
  confirmExistingData: boolean
  identityRoot?: string
}

export function parseIdentityCliArguments(values: string[]): IdentityCliArguments {
  const [command, ...rest] = values
  if (command !== 'init' && command !== 'verify') {
    throw new Error('Usage: instance-identity <init|verify> [--mode fresh|adopt-existing] [--confirm-existing-data] [--identity-dir ABSOLUTE_PATH]')
  }
  const result: IdentityCliArguments = { command, confirmExistingData: false }
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]
    if (value === '--confirm-existing-data' && command === 'init') {
      if (result.confirmExistingData) throw new Error('Duplicate --confirm-existing-data')
      result.confirmExistingData = true
      continue
    }
    if (value === '--mode' && command === 'init') {
      const mode = rest[index + 1]
      if (mode !== 'fresh' && mode !== 'adopt-existing') {
        throw new Error('--mode must be fresh or adopt-existing')
      }
      if (result.mode) throw new Error('Duplicate --mode')
      result.mode = mode === 'fresh' ? 'fresh' : 'adopt_existing'
      index += 1
      continue
    }
    if (value === '--identity-dir') {
      const identityRoot = rest[index + 1]
      if (!identityRoot || result.identityRoot) throw new Error('--identity-dir requires one unique absolute path')
      result.identityRoot = identityRoot
      index += 1
      continue
    }
    throw new Error(`Unsupported identity CLI argument: ${value}`)
  }
  if (command === 'init' && !result.mode) throw new Error('Initialization requires an explicit --mode')
  if (command === 'verify' && (result.confirmExistingData || result.mode)) {
    throw new Error('verify does not accept initialization options')
  }
  return result
}

function assertIsolatedEnvironment(config: AppConfig, databaseName: string): void {
  if (config.nodeEnv === 'production') {
    throw new InstallationIdentityError('unavailable', 'identity_cli_disabled_in_production', 'The development identity CLI is disabled in production')
  }
  if (config.nodeEnv !== 'development' && config.nodeEnv !== 'test') {
    throw new InstallationIdentityError('unavailable', 'identity_cli_environment_unsupported', 'The identity CLI is limited to development and test environments')
  }
  if (config.nodeEnv === 'test' && !databaseName.endsWith('_test')) {
    throw new InstallationIdentityError('unavailable', 'identity_cli_test_database_required', 'Test identity initialization requires a PostgreSQL database ending in _test')
  }
  if (config.nodeEnv === 'development' && !databaseName.endsWith('_dev') && !databaseName.endsWith('_test')) {
    throw new InstallationIdentityError('unavailable', 'identity_cli_isolated_database_required', 'Development identity initialization requires a database ending in _dev or _test')
  }
}

export async function runInstallationIdentityCli(
  pool: Pool,
  config: AppConfig,
  args: IdentityCliArguments,
): Promise<{ exitCode: number; output: Record<string, unknown> }> {
  const result = await pool.query<{ database_name: string }>('SELECT current_database() AS database_name')
  const databaseName = result.rows[0]?.database_name
  if (!databaseName) {
    return { exitCode: 1, output: { status: 'unavailable', code: 'database_name_unavailable' } }
  }
  assertIsolatedEnvironment(config, databaseName)
  const forbiddenRoots = [config.mediaRoot, config.privateFileRoot]
  const snapshot = args.command === 'init'
    ? await initializeInstallationIdentity(pool, {
        identityRoot: args.identityRoot ?? config.identityRoot,
        mode: args.mode!,
        confirmExistingData: args.confirmExistingData,
        forbiddenRoots,
      })
    : await verifyInstallationIdentity(pool, args.identityRoot ?? config.identityRoot, forbiddenRoots)
  return {
    exitCode: snapshot.status === 'ready' ? 0 : 1,
    output: { ...snapshot, databaseName },
  }
}

async function main(): Promise<void> {
  let parsed: IdentityCliArguments
  try {
    parsed = parseIdentityCliArguments(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Invalid identity CLI arguments'}\n`)
    process.exitCode = 2
    return
  }

  const { readConfig } = await import('../config.js')
  const { createPostgresPool } = await import('../db/pool.js')
  const config = readConfig()
  const pool = createPostgresPool({ applicationName: 'aikayun-identity-cli' })
  try {
    const result = await runInstallationIdentityCli(pool, config, parsed)
    process.stdout.write(`${JSON.stringify(result.output)}\n`)
    process.exitCode = result.exitCode
  } catch (error) {
    const status = error instanceof InstallationIdentityError ? error.status : 'unavailable'
    const code = error instanceof InstallationIdentityError ? error.code : 'identity_cli_unavailable'
    process.stderr.write(`${JSON.stringify({ status, code })}\n`)
    process.exitCode = 1
  } finally {
    await pool.end()
  }
}

if (process.argv[1]?.endsWith('installation-identity-cli.js')
  || process.argv[1]?.endsWith('installation-identity-cli.ts')) {
  await main()
}
