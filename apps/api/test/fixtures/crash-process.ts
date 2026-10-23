import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import type { AppConfig } from '../../src/config.js'

export async function startCrashProcess(config: AppConfig, checkpoint: string, targetOperation?: string) {
  const encodeRing = (ring: AppConfig['codePoolEncryptionKeyRing']) => ring ? JSON.stringify({
    activeKeyId: ring.activeKeyId,
    keys: Object.fromEntries(Object.entries(ring.keys).map(([id, key]) => [id, key.toString('base64')])),
  }) : ''
  const child = fork(fileURLToPath(new URL('./crash-boundary-process.ts', import.meta.url)), [], {
    execArgv: ['--import', 'tsx'],
    env: {
      ...process.env,
      NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL,
      PUBLIC_ORIGIN: config.publicOrigin, COOKIE_SECURE: 'false',
      MEDIA_ROOT: config.mediaRoot, PRIVATE_FILE_ROOT: config.privateFileRoot,
      PAYMENT_CREDENTIAL_KEY_RING: encodeRing(config.paymentCredentialKeyRing),
      CODE_POOL_ENCRYPTION_KEY_RING: encodeRing(config.codePoolEncryptionKeyRing),
      SUPPLIER_HTTP_TEST_ALLOWLIST: config.supplierHttpTestAllowlist.join(','),
      CRASH_CHECKPOINT: checkpoint,
      CRASH_TARGET_OPERATION: targetOperation,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  const messages: Record<string, unknown>[] = []
  child.on('message', message => messages.push(message as Record<string, unknown>))
  let stderr = ''
  let stdout = ''
  child.stdout?.on('data', chunk => { stdout += chunk })
  child.stderr?.on('data', chunk => { stderr += chunk })
  async function waitFor(key: string, expected?: unknown) {
    const matches = (message: Record<string, unknown>) => key in message && (expected === undefined || message[key] === expected)
    const existing = messages.find(matches)
    if (existing) return existing[key]
    return await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error(`Crash process timed out at ${key}: ${stderr}`)), 15_000)
      const receive = (message: Record<string, unknown>) => {
        if ('failed' in message) finish(new Error(String(message.failed)))
        else if (matches(message)) finish(undefined, message[key])
      }
      const exited = () => finish(new Error(`Crash process exited before ${key}: ${stderr}`))
      function finish(error?: Error, value?: unknown) {
        clearTimeout(timeout)
        child.off('message', receive)
        child.off('exit', exited)
        if (error) reject(error)
        else resolve(value)
      }
      child.on('message', receive)
      child.once('exit', exited)
    })
  }
  async function kill() {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exit = once(child, 'exit')
    child.kill('SIGKILL')
    const [, signal] = await exit
    if (signal !== 'SIGKILL') throw new Error('Crash acceptance requires real SIGKILL')
  }
  try {
    const origin = String(await waitFor('ready'))
    let runNumber = 0
    return { origin, child, waitFor, kill,
      logs: () => stdout,
      run: () => { child.send({ run: ++runNumber }); return runNumber },
      pass: async () => { const run = ++runNumber; child.send({ run }); await waitFor('done', run) },
    }
  } catch (error) {
    await kill()
    throw error
  }
}
