import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import { readConfig } from '../config.js'
import type { Database } from './types.js'

export function createDatabase(): Kysely<Database> {
  const config = readConfig()
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new Pool({
        ...config.database,
        max: 10,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
        application_name: 'aikayun-api',
      }),
    }),
  })
}
