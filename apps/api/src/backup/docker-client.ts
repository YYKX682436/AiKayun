import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { hostDockerExec, hostDockerSpawn, hostDockerSpawnFile } from './host-operations.js'

const exec = promisify(execFile)

function assertTestDocker(binary?: string, socket?: string): asserts binary is string {
  if (process.env.NODE_ENV !== 'test' || typeof binary !== 'string' || typeof socket !== 'string') {
    throw new Error('BACKUP_HOST_BROKER_REQUIRED')
  }
}

/** Production Docker calls are relayed over the per-command host broker. The
 * direct client path exists only for isolated source tests. */
export async function dockerExec(binary: string | undefined, socket: string | undefined, args: string[], options: {
  timeoutMs?: number; maxBuffer?: number; home?: string; signal?: AbortSignal
} = {}): Promise<string> {
  if (process.env.NODE_ENV === 'production' && process.env.AIKAYUN_BACKUP_HOST_BROKER === 'stdio-v1') {
    return hostDockerExec(args, { ...(options.maxBuffer ? { maxBuffer: options.maxBuffer } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}), ...(options.signal ? { signal: options.signal } : {}) })
  }
  assertTestDocker(binary, socket)
  const result = await exec(binary, ['--host', `unix://${socket}`, ...args], {
    env: { PATH: '/usr/bin:/bin', HOME: options.home ?? '/var/empty', LANG: 'C' },
    timeout: options.timeoutMs ?? 60_000, maxBuffer: options.maxBuffer ?? 1024 * 1024,
    ...(options.signal ? { signal: options.signal } : {}),
  })
  return result.stdout
}

export function dockerSpawn(binary: string | undefined, socket: string | undefined, args: string[], options: {
  home?: string; signal?: AbortSignal; input?: boolean; maxBytes?: number
} = {}): ChildProcess {
  if (process.env.NODE_ENV === 'production' && process.env.AIKAYUN_BACKUP_HOST_BROKER === 'stdio-v1') {
    const child = hostDockerSpawn(args, { ...(options.maxBytes ? { maxBytes: options.maxBytes } : {}), ...(options.signal ? { signal: options.signal } : {}) })
    if (!options.input) child.stdin?.end()
    return child
  }
  assertTestDocker(binary, socket)
  return spawn(binary, ['--host', `unix://${socket}`, ...args], {
    env: { PATH: '/usr/bin:/bin', HOME: options.home ?? '/var/empty', LANG: 'C' },
    stdio: [options.input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  })
}

export function dockerSpawnFile(binary: string | undefined, socket: string | undefined, args: string[], inputPath: string, options: {
  home?: string; signal?: AbortSignal; maxBytes?: number
} = {}): ChildProcess {
  if (process.env.NODE_ENV === 'production' && process.env.AIKAYUN_BACKUP_HOST_BROKER === 'stdio-v1') {
    return hostDockerSpawnFile(args, inputPath, { ...(options.maxBytes ? { maxBytes: options.maxBytes } : {}), ...(options.signal ? { signal: options.signal } : {}) })
  }
  assertTestDocker(binary, socket)
  return spawn(binary, ['--host', `unix://${socket}`, ...args], {
    env: { PATH: '/usr/bin:/bin', HOME: options.home ?? '/var/empty', LANG: 'C' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}
