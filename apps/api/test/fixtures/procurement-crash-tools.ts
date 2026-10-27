import { fork, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AppConfig } from '../../src/config.js'

type Message = Record<string, unknown>

function ringValue(ring: AppConfig['paymentCredentialKeyRing'] | AppConfig['codePoolEncryptionKeyRing']): string {
  if (!ring) return ''
  return JSON.stringify({ activeKeyId: ring.activeKeyId,
    keys: Object.fromEntries(Object.entries(ring.keys).map(([id, key]) => [id, key.toString('base64')])) })
}

function waitForMessage(child: ChildProcess, messages: Message[], key: string, expected?: unknown): Promise<unknown> {
  const matches = (message: Message) => key in message && (expected === undefined || message[key] === expected)
  const existing = messages.find(matches)
  if (existing) return Promise.resolve(existing[key])
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('Timed out waiting for ' + key)), 20_000)
    const receive = (message: Message) => {
      if ('failed' in message) finish(new Error(String(message.failed)))
      else if (matches(message)) finish(undefined, message[key])
    }
    const exited = (code: number | null, signal: NodeJS.Signals | null) =>
      finish(new Error('Process exited before ' + key + ' (code=' + code + ', signal=' + signal + ')'))
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

export async function startProcurementSupplierProcess() {
  const root = await mkdtemp(join(tmpdir(), 'aikayun-procurement-supplier-'))
  const fixture = fileURLToPath(new URL('./procurement-supplier-process.mjs', import.meta.url))
  const child = spawn(process.execPath, [fixture, root], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', chunk => { stdout += chunk.toString() })
  child.stderr?.on('data', chunk => { stderr += chunk.toString() })
  const started = await new Promise<{ ready: string; pid: number }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Supplier process did not start: ' + stderr)), 10_000)
    const receive = () => {
      const newline = stdout.indexOf('\n')
      if (newline < 0) return
      clearTimeout(timeout)
      child.stdout?.off('data', receive)
      try { resolve(JSON.parse(stdout.slice(0, newline)) as { ready: string; pid: number }) }
      catch (error) { reject(error) }
    }
    child.stdout?.on('data', receive)
    child.once('exit', (code, signal) => reject(new Error('Supplier process exited (code=' + code + ', signal=' + signal + '): ' + stderr)))
  })
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(started.ready + path, { method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
    if (!response.ok) throw new Error('Supplier fixture HTTP ' + response.status + ' at ' + path)
    return await response.json() as Record<string, unknown>
  }
  return {
    url: started.ready,
    pid: started.pid,
    control: (value: Record<string, unknown>) => request('/control', value),
    release: () => request('/release', {}),
    stats: async () => await request('/stats') as { pid: number; submitRequests: number; queryRequests: number; executions: number; events: Message[] },
    close: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit')
        child.kill('SIGTERM')
        await exited
      }
      await rm(root, { recursive: true, force: true })
    },
    logs: () => stderr,
  }
}

export async function startProcurementCrashProcess(config: AppConfig, checkpoint?: string) {
  const fixture = fileURLToPath(new URL('./procurement-crash-process.ts', import.meta.url))
  const child = fork(fixture, [], {
    execArgv: ['--import', 'tsx'],
    env: {
      ...process.env,
      NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL,
      PUBLIC_ORIGIN: config.publicOrigin, COOKIE_SECURE: 'false',
      MEDIA_ROOT: config.mediaRoot, PRIVATE_FILE_ROOT: config.privateFileRoot,
      PAYMENT_CREDENTIAL_KEY_RING: ringValue(config.paymentCredentialKeyRing),
      CODE_POOL_ENCRYPTION_KEY_RING: ringValue(config.codePoolEncryptionKeyRing),
      PROCUREMENT_CRASH_CHECKPOINT: checkpoint ?? '',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  const messages: Message[] = []
  let stdout = '', stderr = ''
  child.on('message', message => messages.push(message as Message))
  child.stdout?.on('data', chunk => { stdout += chunk })
  child.stderr?.on('data', chunk => { stderr += chunk })
  try {
    const ready = await waitForMessage(child, messages, 'ready') as { pid: number; backendPid: number }
    return {
      child, ready,
      run: async (command: Record<string, unknown>) => {
        const exited = once(child, 'exit')
        child.send(command)
        await waitForMessage(child, messages, 'done', command.action)
        const [code, signal] = await exited as [number | null, NodeJS.Signals | null]
        if (code !== 0 || signal !== null) throw new Error('Worker exited unexpectedly (code=' + code + ', signal=' + signal + '): ' + stderr)
        return messages.find(message => message.done === command.action)?.result
      },
      waitFor: async (key: string) => {
        try { return await waitForMessage(child, messages, key) }
        catch (error) { throw new Error(String(error) + '\n' + stderr + '\n' + stdout + '\n' + JSON.stringify(messages), { cause: error }) }
      },
      kill: async () => {
        if (child.exitCode !== null || child.signalCode !== null) return child.signalCode
        const exited = once(child, 'exit')
        child.kill('SIGKILL')
        const [, signal] = await exited as [number | null, NodeJS.Signals | null]
        if (signal !== 'SIGKILL') throw new Error('Expected actual SIGKILL, received ' + signal + ': ' + stderr)
        return signal
      },
      logs: () => ({ stdout, stderr }),
    }
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    }
    throw error
  }
}

export async function startPurchaseArchiveCrashApi(config: AppConfig, checkpoint?: string) {
  const fixture = fileURLToPath(new URL('./purchase-archive-crash-api.ts', import.meta.url))
  const child = fork(fixture, [], {
    execArgv: ['--import', 'tsx'],
    env: {
      ...process.env,
      NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL,
      PUBLIC_ORIGIN: config.publicOrigin, COOKIE_SECURE: 'false',
      MEDIA_ROOT: config.mediaRoot, PRIVATE_FILE_ROOT: config.privateFileRoot,
      PAYMENT_CREDENTIAL_KEY_RING: ringValue(config.paymentCredentialKeyRing),
      CODE_POOL_ENCRYPTION_KEY_RING: ringValue(config.codePoolEncryptionKeyRing),
      PURCHASE_ARCHIVE_CRASH_CHECKPOINT: checkpoint ?? '',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  const messages: Message[] = []
  let stdout = '', stderr = ''
  child.on('message', message => messages.push(message as Message))
  child.stdout?.on('data', chunk => { stdout += chunk })
  child.stderr?.on('data', chunk => { stderr += chunk })
  try {
    const ready = await waitForMessage(child, messages, 'ready') as { url: string; pid: number; backendPid: number }
    return {
      child, ready,
      waitFor: async (key: string) => {
        try { return await waitForMessage(child, messages, key) }
        catch (error) { throw new Error(String(error) + '\n' + stderr + '\n' + stdout + '\n' + JSON.stringify(messages), { cause: error }) }
      },
      kill: async () => {
        if (child.exitCode !== null || child.signalCode !== null) return child.signalCode
        const exited = once(child, 'exit')
        child.kill('SIGKILL')
        const [, signal] = await exited as [number | null, NodeJS.Signals | null]
        if (signal !== 'SIGKILL') throw new Error('Expected actual SIGKILL, received ' + signal + ': ' + stderr)
        return signal
      },
      logs: () => ({ stdout, stderr }),
    }
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    }
    throw error
  }
}
