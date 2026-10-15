import type { Migration } from 'kysely/migration'

export const adminAuthMigration: Migration = {
  async up(db) {
    await db.schema
      .createTable('admin_users')
      .addColumn('id', 'uuid', (column) => column.primaryKey())
      .addColumn('email', 'varchar(254)', (column) => column.notNull().unique())
      .addColumn('password_hash', 'text', (column) => column.notNull())
      .addColumn('is_active', 'boolean', (column) => column.notNull().defaultTo(true))
      .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(db.fn('now', [])))
      .addColumn('updated_at', 'timestamptz', (column) => column.notNull().defaultTo(db.fn('now', [])))
      .execute()

    await db.schema
      .createTable('admin_sessions')
      .addColumn('id', 'uuid', (column) => column.primaryKey())
      .addColumn('admin_user_id', 'uuid', (column) => column.notNull().references('admin_users.id').onDelete('cascade'))
      .addColumn('token_hash', 'char(64)', (column) => column.notNull().unique())
      .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(db.fn('now', [])))
      .addColumn('expires_at', 'timestamptz', (column) => column.notNull())
      .addColumn('revoked_at', 'timestamptz')
      .execute()

    await db.schema
      .createIndex('admin_sessions_active_user_idx')
      .on('admin_sessions')
      .column('admin_user_id')
      .column('expires_at')
      .execute()
  },
  async down(db) {
    await db.schema.dropTable('admin_sessions').ifExists().execute()
    await db.schema.dropTable('admin_users').ifExists().execute()
  },
}
