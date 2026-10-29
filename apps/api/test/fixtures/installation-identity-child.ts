import { Pool } from 'pg'
import { initializeInstallationIdentity } from '../../src/licensing/installation-identity.js'

const [schema, identityRoot, checkpoint] = process.argv.slice(2)
const connectionString = process.env.TEST_DATABASE_URL
if (!schema || !identityRoot || !connectionString) throw new Error('Missing isolated identity child settings')

const pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 1 })
try {
  const result = await initializeInstallationIdentity(pool, {
    identityRoot,
    mode: 'fresh',
    onCheckpoint: name => {
      if (checkpoint === name) process.kill(process.pid, 'SIGKILL')
    },
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
} catch (error) {
  process.stderr.write(`${JSON.stringify({ code: (error as { code?: string }).code ?? 'unexpected' })}\n`)
  process.exitCode = 1
} finally {
  await pool.end()
}
