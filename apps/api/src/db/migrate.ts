import { Migrator } from 'kysely/migration'
import { createDatabase } from './pool.js'
import { AppMigrationProvider } from './migration-provider.js'

const db = createDatabase()
try {
  const migrator = new Migrator({ db, provider: new AppMigrationProvider() })
  const { error, results } = await migrator.migrateToLatest()
  for (const result of results ?? []) {
    console.info(`${result.status}: ${result.migrationName}`)
  }
  if (error) throw error
} finally {
  await db.destroy()
}
