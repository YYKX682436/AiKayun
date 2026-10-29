import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import { readConfig } from '../config.js'
import type { Database } from './types.js'

export function createPostgresPool(options: { applicationName?: string } = {}): Pool {
  const config = readConfig()
  return new Pool({
    ...config.database,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: options.applicationName ?? 'aikayun-api',
  })
}

export function createDatabase(): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: createPostgresPool(),
    }),
  })
}
