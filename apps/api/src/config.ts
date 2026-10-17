import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { PoolConfig } from 'pg'

const rootEnvCandidates = [
  resolve(process.cwd(), '.env'),
  resolve(process.cwd(), '../../.env'),
  resolve(import.meta.dirname, '../../../.env'),
]
const rootEnvPath = rootEnvCandidates.find((path) => existsSync(path))
if (rootEnvPath) process.loadEnvFile(rootEnvPath)

function repositoryRoot(): string | undefined {
  const candidates = [
    process.cwd(),
    resolve(process.cwd(), '../..'),
    resolve(import.meta.dirname, '../../..'),
  ]
  return candidates.find((candidate) =>
    existsSync(resolve(candidate, 'apps/api/package.json'))
      && existsSync(resolve(candidate, 'packages/contracts/package.json')))
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

export interface AppConfig {
  nodeEnv: string
  host: string
  port: number
  publicOrigin: string
  cookieSecure: boolean
  trustProxy: boolean
  sessionTtlSeconds: number
  mediaRoot: string
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

  const configuredMediaRoot = env.MEDIA_ROOT
  if (configuredMediaRoot && !isAbsolute(configuredMediaRoot)) {
    throw new Error('MEDIA_ROOT must be an absolute path')
  }
  const xdgDataHome = env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share')
  if (!isAbsolute(xdgDataHome)) throw new Error('XDG_DATA_HOME must be an absolute path')
  const mediaRoot = resolve(configuredMediaRoot ?? join(xdgDataHome, 'aikayun', 'media'))
  const repo = repositoryRoot()
  if (repo && isWithin(repo, mediaRoot)) {
    throw new Error('MEDIA_ROOT must be outside the repository')
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
    host: env.API_HOST ?? '127.0.0.1',
    port: env.API_PORT ? Number(env.API_PORT) : 3001,
    publicOrigin: origin,
    cookieSecure,
    trustProxy: parseBoolean(env.TRUST_PROXY, false),
    sessionTtlSeconds: 60 * 60 * 12,
    mediaRoot,
    database,
  }
}
