import { Writable } from 'node:stream'
import { hostDockerSpawn, hostOperation } from '../../src/backup/host-operations.js'

const child = hostDockerSpawn(['exec', 'fixture-container', 'pg_dump'], { maxBytes: 1024 * 1024 })
child.stderr!.resume()
child.on('error', () => {})
const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
const sink = new Writable({ highWaterMark: 1, write(_chunk, _encoding, callback) {
  setImmediate(() => callback(new Error('synthetic ENOSPC')))
} })

try {
  await new Promise<void>((resolve, reject) => {
    child.stdout!.pipe(sink).once('finish', resolve).once('error', reject)
  })
  throw new Error('fixture sink unexpectedly accepted the stream')
} catch (error) {
  if (!(error instanceof Error) || error.message === 'fixture sink unexpectedly accepted the stream') throw error
}

child.kill('SIGKILL')
await closed
await hostOperation('assert-lock')
process.stdout.write('RESULT_OK\n')
