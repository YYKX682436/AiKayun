import { createApp } from '../../src/app.js'
import { readConfig } from '../../src/config.js'
import { createDatabase } from '../../src/db/pool.js'

const db = createDatabase()
const config = readConfig()
const app = await createApp({ db, config: { ...config, nodeEnv: 'production' } })
app.get('/logging-probe/:id', async () => {
  const error = Object.assign(new Error('PRIVATE_EXCEPTION_MARKER'), {
    name: 'PRIVATE_NAME_MARKER', code: 'PRIVATE_CODE_MARKER', detail: 'PRIVATE_ROW_MARKER',
  })
  throw error
})
await app.inject({ method: 'POST', url: '/api/v1/admin/auth/login?token=PRIVATE_QUERY_MARKER',
  headers: { cookie: 'session=PRIVATE_COOKIE_MARKER', authorization: 'Bearer PRIVATE_AUTH_MARKER' },
  payload: { password: 'PRIVATE_BODY_MARKER' } })
await app.inject({ method: 'GET', url: '/logging-probe/PRIVATE_PATH_MARKER?sign=PRIVATE_QUERY_MARKER' })
const docs = await app.inject({ method: 'GET', url: '/api/docs/json' })
if (docs.statusCode !== 404) throw new Error('Production OpenAPI was exposed')
await app.close()
await db.destroy()
