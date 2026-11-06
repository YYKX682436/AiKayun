import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { FileHandle } from 'node:fs/promises'

export type ResticOutputSink = { limit: number; write(chunk: Buffer): Promise<void> }
export type ResticCommandExecutor = {
  execute(args: string[], source?: string, sink?: ResticOutputSink): Promise<string>
}
type LocalResticConfig = { binary?: string; repository: string; passwordFile: string; timeoutMs?: number; signal?: AbortSignal; executor?: ResticCommandExecutor }
const snapshotId = /^[a-f0-9]{64}$/
const setId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export type BackupSnapshotRole = 'source' | 'manifest'

function roleTag(role: BackupSnapshotRole): string { return `aikayun-role-${role}` }

function resticCommandFailure(operation: string | undefined): Error {
  const safeOperation = operation && /^[a-z]{1,32}$/.test(operation) ? operation.toUpperCase() : 'UNKNOWN'
  const error = new Error('RESTIC_COMMAND_FAILED')
  Object.defineProperty(error, 'operationCode', { value: `RESTIC_${safeOperation}_FAILED`, enumerable: true })
  return error
}

export function within(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

export async function canonical(path: string, kind: 'file' | 'directory'): Promise<string> {
  const failPath = () => {
    const fixedLabel = path === '/var/lib/aikayun-backup/repository' ? 'REPOSITORY'
      : path === '/var/lib/aikayun-backup/publications' ? 'PUBLICATIONS'
      : path === '/var/lib/aikayun-backup/staging' ? 'STAGING'
      : path === '/etc/aikayun-backup/restic-password' ? 'PASSWORD'
      : 'OTHER'
    const error = new Error('RESTIC_PATH_INVALID')
    Object.defineProperty(error, 'operationCode', { value: `RESTIC_PATH_INVALID_${fixedLabel}`, enumerable: true })
    return error
  }
  if (!isAbsolute(path) || resolve(path) !== path) throw failPath()
  const stat = await lstat(path)
  if (stat.isSymbolicLink() || (kind === 'file' ? !stat.isFile() : !stat.isDirectory())) throw failPath()
  const resolved = await realpath(path)
  if (resolved !== path) throw failPath()
  return resolved
}

export async function trustedAncestors(path: string): Promise<void> {
  let current = dirname(path)
  while (true) {
    const stat = await lstat(current)
    const uid = typeof process.getuid === 'function' ? process.getuid() : -1
    const stickyRoot = stat.uid === 0 && (stat.mode & 0o1000) !== 0
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.uid !== 0 && stat.uid !== uid) ||
        ((stat.mode & 0o022) !== 0 && !stickyRoot)) throw new Error('RESTIC_ANCESTOR_UNSAFE')
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
}

export async function privateDirectory(path: string): Promise<void> {
  const stat = await lstat(path)
  if ((stat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new Error('RESTIC_DIRECTORY_UNSAFE')
  await trustedAncestors(path)
}

/** Only a trusted caller can select the executable or the private staging paths. */
export class LocalResticRepository {
  constructor(private readonly config: LocalResticConfig) {}

  /** Fixed paths are exposed only to the separately confined Restic reader. */
  storagePaths(): { binary?: string; repository: string; passwordFile: string } {
    return { ...(this.config.binary ? { binary: this.config.binary } : {}), repository: this.config.repository, passwordFile: this.config.passwordFile }
  }

  private async execute(args: string[], source?: string, sink?: ResticOutputSink): Promise<string> {
    if (this.config.signal?.aborted) throw new Error('RESTIC_COMMAND_INTERRUPTED')
    const repository = await canonical(this.config.repository, 'directory')
    const passwordPath = await canonical(this.config.passwordFile, 'file')
    const binary = this.config.binary ? await canonical(this.config.binary, 'file') : undefined
    if (!binary && !this.config.executor) throw new Error('RESTIC_EXECUTABLE_UNAVAILABLE')
    if (binary) {
      await trustedAncestors(binary)
      const executable = await lstat(binary)
      if (executable.nlink !== 1 || (executable.mode & 0o022) !== 0 || (executable.mode & 0o111) === 0 ||
          (typeof process.getuid === 'function' && executable.uid !== 0 && executable.uid !== process.getuid())) throw new Error('RESTIC_EXECUTABLE_UNSAFE')
    }
    await privateDirectory(repository)
    await trustedAncestors(passwordPath)
    if (within(repository, passwordPath) || within(passwordPath, repository)) throw new Error('RESTIC_PASSWORD_LOCATION_INVALID')
    if (source) {
      const staging = await canonical(source, 'directory')
      await privateDirectory(staging)
      if (within(staging, repository) || within(repository, staging) || within(staging, passwordPath)) throw new Error('RESTIC_SOURCE_LOCATION_INVALID')
    }
    const password = await open(passwordPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = await password.stat()
      if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > 4096 || (stat.mode & 0o077) !== 0 ||
          (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new Error('RESTIC_PASSWORD_FILE_INVALID')
      if (this.config.executor) return await this.config.executor.execute(args, source, sink)
      const timeoutMs = this.config.timeoutMs ?? 6 * 60 * 60 * 1000
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 6 * 60 * 60 * 1000) throw new Error('RESTIC_TIMEOUT_INVALID')
      if (!binary) throw new Error('RESTIC_EXECUTABLE_UNAVAILABLE')
      return await new Promise<string>((accept, reject) => {
        const child = spawn(binary, ['--repo', repository, '--password-file', '/dev/fd/3', '--no-cache', '--quiet', ...args], {
          env: { PATH: '/usr/bin:/bin', LANG: 'C', HOME: repository },
          stdio: ['ignore', 'pipe', 'pipe', password.fd],
        })
        let output = ''
        let stdoutBytes = 0
        let overLimit = false
        let timedOut = false
        let interrupted = false
        let stderrBytes = 0
        let killTimer: ReturnType<typeof setTimeout> | undefined
        const stop = () => {
          child.kill('SIGTERM')
          killTimer ??= setTimeout(() => child.kill('SIGKILL'), 2000)
        }
        const interrupt = () => { interrupted = true; stop() }
        this.config.signal?.addEventListener('abort', interrupt, { once: true })
        if (this.config.signal?.aborted) interrupt()
        const timer = setTimeout(() => { timedOut = true; stop() }, timeoutMs)
        let streamResult: Promise<void> = Promise.resolve()
        if (sink) {
          const limit = new Transform({ transform(chunk: Buffer, _encoding, callback) {
            stdoutBytes += chunk.length
            if (stdoutBytes > sink.limit) { overLimit = true; callback(new Error('RESTIC_OUTPUT_TOO_LARGE')) }
            else callback(null, chunk)
          } })
          const writer = new Writable({ write(chunk: Buffer, _encoding, callback) {
            void sink.write(chunk).then(() => callback(), error => callback(error as Error))
          } })
          streamResult = pipeline(child.stdout!, limit, writer).catch(() => { overLimit = true; stop() })
        } else {
          child.stdout!.on('data', (chunk: Buffer) => {
            stdoutBytes += chunk.length
            if (stdoutBytes > 1024 * 1024) { overLimit = true; stop(); return }
            output += chunk.toString('utf8')
          })
        }
        // Never propagate untrusted stderr, which may contain paths or other sensitive values.
        child.stderr!.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 1024 * 1024) { overLimit = true; stop() } })
        let spawnError = false
        child.once('error', () => { spawnError = true })
        child.once('close', async code => {
          await streamResult
          clearTimeout(timer)
          this.config.signal?.removeEventListener('abort', interrupt)
          if (killTimer) clearTimeout(killTimer)
          if (interrupted) reject(new Error('RESTIC_COMMAND_INTERRUPTED'))
          else if (timedOut) reject(new Error('RESTIC_COMMAND_TIMEOUT'))
          else if (spawnError) reject(new Error('RESTIC_EXEC_FAILED'))
          else if (code === 0 && !overLimit) accept(output)
          else reject(resticCommandFailure(args[0]))
        })
      })
    } finally { await password.close() }
  }

  async assertRepositoryPath(path: string): Promise<void> {
    if (await canonical(this.config.repository, 'directory') !== path) throw new Error('RESTIC_PATH_INVALID')
  }

  async initialize(): Promise<void> {
    const directory = await canonical(this.config.repository, 'directory')
    if ((await readdir(directory)).length !== 0) throw new Error('RESTIC_REPOSITORY_NOT_EMPTY')
    await this.execute(['init', '--repository-version', '2'])
  }

  /** The decrypted restic repository identifier is stable across operations;
   * never print raw config or password material. */
  async repositoryIdentity(): Promise<string> {
    let value: unknown
    try { value = JSON.parse(await this.execute(['cat', 'config'])) as unknown } catch { throw new Error('RESTIC_REPOSITORY_ID_INVALID') }
    if (!value || typeof value !== 'object' || Array.isArray(value) || !('id' in value) || typeof value.id !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.id) || !('version' in value) || value.version !== 2) throw new Error('RESTIC_REPOSITORY_ID_INVALID')
    return value.id
  }

  async backup(source: string, backupSetId: string): Promise<string> {
    if (!setId.test(backupSetId)) throw new Error('RESTIC_SET_ID_INVALID')
    if ((await this.snapshotsForSet(backupSetId)).length !== 0) throw new Error('RESTIC_SET_ALREADY_EXISTS')
    const output = await this.execute(['backup', '--json', '--tag', `aikayun-set-${backupSetId}`, '--', source], source)
    let id: string | undefined
    for (const line of output.trim().split('\n')) {
      let event: unknown
      try { event = JSON.parse(line) as unknown } catch { throw new Error('RESTIC_RESULT_INVALID') }
      if (event && typeof event === 'object' && 'message_type' in event && event.message_type === 'summary' && 'snapshot_id' in event && typeof event.snapshot_id === 'string') id = event.snapshot_id
    }
    // restic emits a short snapshot id in its backup summary; resolve it through
    // the authenticated snapshot listing before reporting success.
    if (!id || !/^[a-f0-9]{8,64}$/.test(id)) throw new Error('RESTIC_RESULT_INVALID')
    const matches = await this.snapshotsForSet(backupSetId)
    if (matches.length !== 1 || !matches[0]!.startsWith(id)) throw new Error('RESTIC_RESULT_INVALID')
    return matches[0]!
  }

  /** Create one explicitly typed member of a paired backup set. Existing
   * snapshots under another role are allowed; a duplicate role is not. */
  async backupRole(source: string, backupSetId: string, role: BackupSnapshotRole): Promise<string> {
    if (!setId.test(backupSetId) || !['source', 'manifest'].includes(role)) throw new Error('RESTIC_SET_ID_INVALID')
    if ((await this.snapshotsForRole(backupSetId, role)).length !== 0) throw new Error('RESTIC_SET_ROLE_ALREADY_EXISTS')
    const output = await this.execute(['backup', '--json', '--tag', `aikayun-set-${backupSetId}`, '--tag', roleTag(role), '--', source], source)
    let shortId: string | undefined
    for (const line of output.trim().split('\n')) {
      let event: unknown
      try { event = JSON.parse(line) as unknown } catch { throw new Error('RESTIC_RESULT_INVALID') }
      if (event && typeof event === 'object' && 'message_type' in event && event.message_type === 'summary' &&
          'snapshot_id' in event && typeof event.snapshot_id === 'string') shortId = event.snapshot_id
    }
    if (!shortId || !/^[a-f0-9]{8,64}$/.test(shortId)) throw new Error('RESTIC_RESULT_INVALID')
    const matches = await this.snapshotsForRole(backupSetId, role)
    if (matches.length !== 1 || !matches[0]!.startsWith(shortId)) throw new Error('RESTIC_RESULT_INVALID')
    return matches[0]!
  }

  async snapshots(): Promise<string[]> {
    const output = await this.execute(['snapshots', '--json'])
    let raw: unknown
    try { raw = JSON.parse(output) as unknown } catch { throw new Error('RESTIC_RESULT_INVALID') }
    if (!Array.isArray(raw) || raw.length > 100000) throw new Error('RESTIC_RESULT_INVALID')
    return raw.map((entry: unknown) => {
      if (!entry || typeof entry !== 'object' || !('id' in entry) || typeof entry.id !== 'string' || !snapshotId.test(entry.id)) throw new Error('RESTIC_RESULT_INVALID')
      return entry.id
    })
  }

  async snapshotsForSet(backupSetId: string): Promise<string[]> {
    if (!setId.test(backupSetId)) throw new Error('RESTIC_SET_ID_INVALID')
    const tag = `aikayun-set-${backupSetId}`
    const output = await this.execute(['snapshots', '--json', '--tag', tag])
    let raw: unknown
    try { raw = JSON.parse(output) as unknown } catch { throw new Error('RESTIC_RESULT_INVALID') }
    if (!Array.isArray(raw) || raw.length > 100000) throw new Error('RESTIC_RESULT_INVALID')
    return raw.map((entry: unknown) => {
      if (!entry || typeof entry !== 'object' || !('id' in entry) || typeof entry.id !== 'string' || !snapshotId.test(entry.id) ||
          !('tags' in entry) || !Array.isArray(entry.tags) || !entry.tags.includes(tag)) throw new Error('RESTIC_RESULT_INVALID')
      return entry.id
    })
  }

  async snapshotsForRole(backupSetId: string, role: BackupSnapshotRole): Promise<string[]> {
    if (!setId.test(backupSetId) || !['source', 'manifest'].includes(role)) throw new Error('RESTIC_SET_ID_INVALID')
    const tag = `aikayun-set-${backupSetId}`
    let raw: unknown
    try { raw = JSON.parse(await this.execute(['snapshots', '--json', '--tag', tag])) as unknown }
    catch { throw new Error('RESTIC_RESULT_INVALID') }
    if (!Array.isArray(raw) || raw.length > 100000) throw new Error('RESTIC_RESULT_INVALID')
    const result: string[] = []
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !('id' in entry) || typeof entry.id !== 'string' ||
          !snapshotId.test(entry.id) || !('tags' in entry) || !Array.isArray(entry.tags) ||
          !entry.tags.every((value: unknown) => typeof value === 'string') || !entry.tags.includes(tag)) throw new Error('RESTIC_RESULT_INVALID')
      if (entry.tags.includes(roleTag(role))) result.push(entry.id)
    }
    return result
  }

  async check(): Promise<void> { await this.execute(['check', '--read-data']) }

  /** Internal primitives for the controlled snapshot reader. */
  async snapshotMetadata(set: string): Promise<unknown> {
    if (!setId.test(set)) throw new Error('RESTIC_SET_ID_INVALID')
    const output = await this.execute(['snapshots', '--json', '--tag', `aikayun-set-${set}`])
    try { return JSON.parse(output) as unknown } catch { throw new Error('RESTIC_RESULT_INVALID') }
  }

  /** Read-only snapshot metadata; callers must filter sensitive fields. */
  async allSnapshotMetadata(): Promise<unknown> {
    const output = await this.execute(['snapshots', '--json'])
    try { return JSON.parse(output) as unknown } catch { throw new Error('RESTIC_RESULT_INVALID') }
  }

  async listSnapshot(snapshot: string, path?: string, recursive = false): Promise<string> {
    if (!snapshotId.test(snapshot)) throw new Error('RESTIC_SNAPSHOT_ID_INVALID')
    if (path !== undefined && (!path.startsWith('/') || path.includes('\0') || path.split('/').some(part => part === '.' || part === '..'))) {
      throw new Error('RESTIC_SNAPSHOT_PATH_INVALID')
    }
    return this.execute(['ls', '--json', ...(recursive ? ['--recursive'] : []), snapshot, ...(path ? [path] : [])])
  }

  /** Stream bounded JSON listing events without retaining customer file paths. */
  async visitSnapshotNodes(snapshot: string, path: string, visitor: (node: Record<string, unknown>) => void): Promise<void> {
    if (!snapshotId.test(snapshot) || !path.startsWith('/') || path.includes('\0') || path.split('/').some(part => part === '.' || part === '..') ||
        typeof visitor !== 'function') throw new Error('RESTIC_SNAPSHOT_PATH_INVALID')
    let pending = Buffer.alloc(0), nodes = 0
    const maximumLine = 64 * 1024, maximumNodes = 2_000_000
    const sink = new Writable({ write(chunk: Buffer, _encoding, callback) {
      try {
        pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk)
        if (pending.length > maximumLine && pending.indexOf(0x0a) < 0) throw new Error('RESTIC_SNAPSHOT_LIST_INVALID')
        while (true) {
          const newline = pending.indexOf(0x0a)
          if (newline < 0) break
          const line = pending.subarray(0, newline)
          pending = pending.subarray(newline + 1)
          if (line.length > maximumLine) throw new Error('RESTIC_SNAPSHOT_LIST_INVALID')
          if (!line.length) continue
          let event: unknown
          try { event = JSON.parse(line.toString('utf8')) as unknown } catch { throw new Error('RESTIC_SNAPSHOT_LIST_INVALID') }
          if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('RESTIC_SNAPSHOT_LIST_INVALID')
          if ('struct_type' in event && event.struct_type === 'node') {
            if (++nodes > maximumNodes) throw new Error('RESTIC_SNAPSHOT_LIST_INVALID')
            visitor(event as Record<string, unknown>)
          }
        }
        callback()
      } catch (error) { callback(error as Error) }
    }, final(callback) {
      try {
        if (pending.length) {
          if (pending.length > maximumLine) throw new Error('RESTIC_SNAPSHOT_LIST_INVALID')
          let event: unknown
          try { event = JSON.parse(pending.toString('utf8')) as unknown } catch { throw new Error('RESTIC_SNAPSHOT_LIST_INVALID') }
          if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('RESTIC_SNAPSHOT_LIST_INVALID')
          if ('struct_type' in event && event.struct_type === 'node') {
            if (++nodes > maximumNodes) throw new Error('RESTIC_SNAPSHOT_LIST_INVALID')
            visitor(event as Record<string, unknown>)
          }
        }
        if (nodes === 0) throw new Error('RESTIC_SNAPSHOT_LIST_INVALID')
        callback()
      } catch (error) { callback(error as Error) }
    } })
    await this.execute(['ls', '--json', '--recursive', snapshot, path], undefined, {
      limit: 512 * 1024 * 1024,
      write: chunk => new Promise<void>((resolve, reject) => sink.write(chunk, error => error ? reject(error) : resolve())),
    })
  }

  async dumpFile(snapshot: string, path: string, destination: FileHandle, size: number): Promise<void> {
    if (!snapshotId.test(snapshot) || !path.startsWith('/') || path.includes('\u0000') ||
        !Number.isSafeInteger(size) || size < 1) throw new Error('RESTIC_DUMP_INVALID')
    let offset = 0
    await this.execute(['dump', snapshot, path], undefined, { limit: size, async write(chunk) {
      let written = 0
      while (written < chunk.length) {
        const result = await destination.write(chunk, written, chunk.length - written, offset + written)
        if (result.bytesWritten === 0) throw new Error('BACKUP_WRITE_FAILED')
        written += result.bytesWritten
      }
      offset += written
    } })
  }

  /** Verify a stored Restic member without materializing a potentially large
   * database dump into a second plaintext file. */
  async hashSnapshotFile(snapshot: string, path: string, maximumBytes: number): Promise<{ size: number; sha256: string }> {
    if (!snapshotId.test(snapshot) || !path.startsWith('/') || path.includes('\0') || path.split('/').some(part => part === '.' || part === '..') ||
        !Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new Error('RESTIC_DUMP_INVALID')
    const hash = createHash('sha256')
    let size = 0
    await this.execute(['dump', snapshot, path], undefined, { limit: maximumBytes, async write(chunk) {
      size += chunk.length
      if (size > maximumBytes) throw new Error('RESTIC_OUTPUT_TOO_LARGE')
      hash.update(chunk)
    } })
    if (size < 1) throw new Error('RESTIC_DUMP_INVALID')
    return { size, sha256: hash.digest('hex') }
  }

  async validateExtractionParent(parent: string): Promise<void> {
    const directory = await canonical(parent, 'directory')
    await privateDirectory(directory)
    const repository = await canonical(this.config.repository, 'directory')
    const password = await canonical(this.config.passwordFile, 'file')
    if (within(repository, directory) || within(directory, repository) || within(directory, password)) {
      throw new Error('RESTIC_OUTPUT_LOCATION_INVALID')
    }
  }

  /** Do not allow publication, journal or plaintext scratch directories to be
   * inside the encrypted repository, or contain its password or repository. */
  async assertSeparatedStorage(paths: readonly string[]): Promise<void> {
    const repository = await canonical(this.config.repository, 'directory')
    await privateDirectory(repository)
    const password = await canonical(this.config.passwordFile, 'file')
    await trustedAncestors(password)
    if (within(repository, password)) throw new Error('RESTIC_PASSWORD_LOCATION_INVALID')
    for (const path of paths) {
      const directory = await canonical(path, 'directory')
      await privateDirectory(directory)
      if (within(directory, repository) || within(repository, directory) || within(directory, password)) {
        throw new Error('RESTIC_STORAGE_OVERLAP')
      }
    }
  }
}
