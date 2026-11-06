import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

it('unblocks broker streaming after a destination failure and keeps the RPC channel usable', async () => {
  const fixture = resolve(import.meta.dirname, 'fixtures/backup-host-operations-stream-child.ts')
  const child = spawn(process.execPath, ['--import', 'tsx', fixture], {
    cwd: resolve(import.meta.dirname, '..'),
    env: { ...process.env, NODE_ENV: 'production', AIKAYUN_BACKUP_HOST_BROKER: 'stdio-v1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity })
  let streamId: string | undefined
  let sawCancel = false
  let sawFollowUp = false
  let sawSuccess = false
  let stderr = ''
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  lines.on('line', line => {
    if (line === 'RESULT_OK') { sawSuccess = true; return }
    const fields = line.split('\t')
    if (fields[0] === 'REQ' && fields[2] === 'docker-stream') {
      streamId = fields[1]
      child.stdin!.write(`RES\t${streamId}\tSTREAM\n`)
      const chunk = Buffer.alloc(256 * 1024, 0x61).toString('base64')
      child.stdin!.write(`RES\t${streamId}\tDATA\t${chunk}\n`)
      return
    }
    if (fields[0] === 'CANCEL' && fields[1] === streamId) {
      sawCancel = true
      child.stdin!.write(`RES\t${streamId}\tEND\t130\n`)
      return
    }
    if (fields[0] === 'REQ' && fields[2] === 'assert-lock') {
      sawFollowUp = true
      child.stdin!.write(`RES\t${fields[1]}\tOK\t\n`)
      child.stdin!.end()
    }
  })
  const timeout = setTimeout(() => child.kill('SIGKILL'), 5000)
  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>(resolveExit => {
    child.once('exit', (exitCode, exitSignal) => resolveExit([exitCode, exitSignal]))
  })
  clearTimeout(timeout)
  lines.close()
  expect({ code, signal, sawCancel, sawFollowUp, sawSuccess, stderr }).toMatchObject({
    code: 0, signal: null, sawCancel: true, sawFollowUp: true, sawSuccess: true,
  })
}, 7000)
