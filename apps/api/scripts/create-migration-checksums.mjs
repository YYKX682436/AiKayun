import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const directory = process.argv[2]
if (!directory) throw new Error('Usage: node create-migration-checksums.mjs DIST_MIGRATIONS_DIRECTORY')
const names = (await readdir(directory)).filter(name => /^\d{12}_[A-Za-z0-9_-]+\.js$/.test(name)).sort()
if (names.length === 0) throw new Error('No compiled migration files found')
const migrations = []
for (const name of names) {
  const bytes = await readFile(join(directory, name))
  migrations.push({ name: name.slice(0, -3), sha256: createHash('sha256').update(bytes).digest('hex') })
}
const record = { schema: 1, migration_head: migrations.at(-1).name, migrations }
await writeFile(join(directory, '..', 'migration-checksums.json'), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' })
