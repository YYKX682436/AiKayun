import { sql } from 'kysely'
import { Migrator } from 'kysely/migration'
import { createDatabase } from './pool.js'
import { AppMigrationProvider } from './migration-provider.js'

const db = createDatabase()
try {
  const databaseName = await sql<{ database_name: string }>`select current_database() as database_name`.execute(db)
  if (!databaseName.rows[0]?.database_name.endsWith('_test')) {
    throw new Error('Refusing to reset a database whose name does not end with _test')
  }
  await sql`drop schema public cascade`.execute(db)
  await sql`create schema public`.execute(db)
  const migrator = new Migrator({ db, provider: new AppMigrationProvider() })
  const { error, results } = await migrator.migrateToLatest()
  for (const result of results ?? []) {
    console.info(`${result.status}: ${result.migrationName}`)
  }
  if (error) throw error
} finally {
  await db.destroy()
}
