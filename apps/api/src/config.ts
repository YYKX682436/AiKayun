import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { PoolConfig } from 'pg'

const rootEnvCandidates = [
  resolve(process.cwd(), '.env'),
  resolve(process.cwd(), '../../.env'),
  resolve(import.meta.dirname, '../../../.env'),
]
const rootEnvPath = rootEnvCandidates.find((path) => existsSync(path))
if (rootEnvPath) process.loadEnvFile(rootEnvPath)

export interface AppConfig {
  nodeEnv: string
  host: string
  port: number
  publicOrigin: string
  cookieSecure: boolean
  trustProxy: boolean
  sessionTtlSeconds: number
  database: PoolConfig
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error('Boolean environment values must be true or false')
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV ?? 'development'
  const origin = env.PUBLIC_ORIGIN ?? 'http://localhost:3000'
  const parsedOrigin = new URL(origin)
  if (parsedOrigin.origin !== origin) {
    throw new Error('PUBLIC_ORIGIN must contain only the public scheme, host and optional port')
  }

  const cookieSecure = parseBoolean(env.COOKIE_SECURE, nodeEnv === 'production')
  const localHttpOrigin = parsedOrigin.protocol === 'http:'
    && ['localhost', '127.0.0.1'].includes(parsedOrigin.hostname)
  if (nodeEnv === 'production' && !cookieSecure && !localHttpOrigin) {
    throw new Error('COOKIE_SECURE must be true in production')
  }

  const database: PoolConfig = env.DATABASE_URL
    ? { connectionString: env.DATABASE_URL }
    : {
        host: env.PGHOST ?? '127.0.0.1',
        port: env.PGPORT ? Number(env.PGPORT) : 5432,
        database: env.PGDATABASE ?? env.POSTGRES_DB ?? 'aikayun',
        user: env.PGUSER ?? env.POSTGRES_USER ?? 'aikayun',
        password: env.PGPASSWORD ?? env.POSTGRES_PASSWORD,
      }

  return {
    nodeEnv,
    host: env.API_HOST ?? '0.0.0.0',
    port: env.API_PORT ? Number(env.API_PORT) : 3001,
    publicOrigin: origin,
    cookieSecure,
    trustProxy: parseBoolean(env.TRUST_PROXY, false),
    sessionTtlSeconds: 60 * 60 * 12,
    database,
  }
}
