import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import type { ChildProcess } from 'node:child_process'
import { lstat, open, realpath, unlink } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { FileHandle } from 'node:fs/promises'
import { UnsafeMaintenanceRecoveryError } from './maintenance-errors.js'
import { AppMigrationProvider } from '../db/migration-provider.js'
import type { readBackupDatabaseMetadata } from './database-metadata.js'
import { trustedAncestors } from './restic-local.js'
import { dockerSpawn, dockerSpawnFile } from './docker-client.js'

export interface PostgresDumpTarget {
  /** Test-only direct CLI fields. Production requests Docker through the host broker. */
  dockerBinary?: string
  dockerSocket?: string
  /** Exact, previously verified PostgreSQL 18 container ID (not a name). */
  containerId: string
  database: string
  user: string
  /** Caller must verify this private directory is on memory or encrypted storage. */
  stagingDirectory: string
  assertSecureStaging: () => Promise<void>
  signal?: AbortSignal | undefined
  timeoutMs?: number
}

async function validate(input: PostgresDumpTarget) {
  const broker = process.env.NODE_ENV === 'production' && process.env.AIKAYUN_BACKUP_HOST_BROKER === 'stdio-v1'
  for (const path of [...(broker ? [] : [input.dockerBinary, input.dockerSocket]), input.stagingDirectory]) {
    if (typeof path !== 'string') throw new Error('DUMP_PATH_INVALID')
    if (!isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path) throw new Error('DUMP_PATH_INVALID')
  }
  const root = await lstat(input.stagingDirectory)
  if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o777) !== 0o700 || root.uid !== process.getuid?.()) {
    throw new Error('DUMP_PATH_INVALID')
  }
  if (!broker) {
    const binaryPath = input.dockerBinary!, socketPath = input.dockerSocket!
    const [binary, socket] = await Promise.all([lstat(binaryPath), lstat(socketPath)])
    if (!binary.isFile() || binary.isSymbolicLink() || binary.nlink !== 1 || (binary.mode & 0o022) !== 0 ||
        (binary.mode & 0o111) === 0 || (binary.uid !== 0 && binary.uid !== process.getuid?.()) ||
        !socket.isSocket() || socket.isSymbolicLink() || (socket.uid !== 0 && socket.uid !== process.getuid?.())) throw new Error('DUMP_PATH_INVALID')
    await trustedAncestors(binaryPath); await trustedAncestors(socketPath)
  }
  if (!/^[a-f0-9]{64}$/.test(input.containerId) || !/^[a-z_][a-z0-9_]{0,62}$/.test(input.database) ||
      !/^[a-z_][a-z0-9_]{0,62}$/.test(input.user)) throw new Error('DUMP_TARGET_INVALID')
  if (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 24 * 60 * 60 * 1000)) throw new Error('DUMP_TIMEOUT_INVALID')
  if (input.signal?.aborted) throw new Error('DUMP_INTERRUPTED')
  await input.assertSecureStaging()
}

/** A bounded local Docker command. stderr is drained but never forwarded. */
async function docker(input: PostgresDumpTarget, args: string[], io: (child: ChildProcess) => Promise<void>, applicationName?: string,
  inputPath?: string) {
  const dockerArgs = ['exec', '-i', ...(applicationName ? ['--env', `PGAPPNAME=${applicationName}`] : []), input.containerId, ...args]
  const broker = process.env.NODE_ENV === 'production' && process.env.AIKAYUN_BACKUP_HOST_BROKER === 'stdio-v1'
  const child = inputPath && broker
    ? dockerSpawnFile(input.dockerBinary, input.dockerSocket, dockerArgs, inputPath, { ...(input.signal ? { signal: input.signal } : {}), maxBytes: 1024 * 1024 })
    : dockerSpawn(input.dockerBinary, input.dockerSocket, dockerArgs, {
      input: true, ...(input.signal ? { signal: input.signal } : {}), maxBytes: inputPath ? 1024 * 1024 : 1024 * 1024 * 1024 * 1024,
    })
  let timedOut = false
  const stop = () => { timedOut = true; child.kill('SIGKILL') }
  const timer = setTimeout(stop, input.timeoutMs ?? 30 * 60 * 1000)
  input.signal?.addEventListener('abort', stop, { once: true })
  if (input.signal?.aborted) stop()
  child.stderr!.resume()
  const exited = new Promise<boolean>(done => {
    child.once('error', () => done(false))
    child.once('close', code => done(code === 0))
  })
  try {
    const [stream, success] = await Promise.all([io(child).then(() => true, () => { child.kill('SIGKILL'); return false }), exited])
    if (timedOut || input.signal?.aborted) throw new Error('DUMP_INTERRUPTED')
    if (!stream || !success) throw new Error('DUMP_COMMAND_FAILED')
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener('abort', stop)
  }
}

async function stopDumpSession(input: PostgresDumpTarget, name: string) {
  let result = ''
  // Bootstrap authority must be verified by the coordinator. Cancellation must
  // still run after the caller's AbortSignal has fired.
  await docker({ ...input, signal: undefined, timeoutMs: 15000 }, ['psql', '-X', '-v', 'ON_ERROR_STOP=1', '-At', '--no-password',
    '--host=/var/run/postgresql', '--port=5432', `--username=${input.user}`, '--dbname=postgres', '-c',
    `SELECT CASE WHEN count(*) > 0 AND bool_and(pg_terminate_backend(pid, 5000)) THEN 'terminated' ELSE 'unknown' END FROM pg_stat_activity WHERE application_name = '${name}' AND pid <> pg_backend_pid()`], async child => {
    child.stdin!.end()
    await pipeline(child.stdout!, new Writable({ write(chunk: Buffer, _encoding, callback) {
      result += chunk.toString('utf8')
      callback(result.length > 128 ? new UnsafeMaintenanceRecoveryError('DUMP_CLEANUP_UNVERIFIED') : undefined)
    } }))
  })
  if (result.trim() !== 'terminated') throw new UnsafeMaintenanceRecoveryError('DUMP_CLEANUP_UNVERIFIED')
}

async function assertPostgres18Tools(input: PostgresDumpTarget) {
  let dumpVersion = ''
  for (const tool of ['pg_dump', 'pg_restore']) {
    let version = ''
    await docker(input, [tool, '--version'], async child => {
      child.stdin!.end()
      await pipeline(child.stdout!, new Writable({ write(chunk: Buffer, _encoding, callback) {
        version += chunk.toString('utf8')
        callback(version.length > 128 ? new Error('DUMP_VERSION_INVALID') : undefined)
      } }))
    })
    if (!new RegExp(`^${tool} \\(PostgreSQL\\) 18(?:\\.|\\s|$)`).test(version)) throw new Error('DUMP_VERSION_INVALID')
    if (tool === 'pg_dump') {
      const match = /^pg_dump \(PostgreSQL\) (18(?:\.\d+){0,2})(?:\s|$)/.exec(version)
      if (!match) throw new Error('DUMP_VERSION_INVALID')
      dumpVersion = match[1]!
    }
  }
  return dumpVersion
}

async function verifyFile(input: PostgresDumpTarget, file: FileHandle) {
  const stat = await file.stat()
  if (!stat.isFile() || stat.nlink !== 1 || stat.size < 5 || (stat.mode & 0o077) !== 0) throw new Error('DUMP_INVALID')
  const magic = Buffer.alloc(5)
  if ((await file.read(magic, 0, 5, 0)).bytesRead !== 5 || magic.toString('ascii') !== 'PGDMP') throw new Error('DUMP_INVALID')
  await docker(input, ['pg_restore', '--exit-on-error', '--file=/dev/null'], async child => {
    if (process.env.NODE_ENV === 'production' && process.env.AIKAYUN_BACKUP_HOST_BROKER === 'stdio-v1') {
      child.stdin!.end()
      await pipeline(child.stdout!, new Writable({ write(_chunk, _encoding, callback) { callback() } }))
      return
    }
    child.stdout!.pipe(new Writable({ write(_chunk, _encoding, callback) { callback() } }))
    const source = Readable.from((async function* () {
      let position = 0
      while (position < stat.size) {
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, stat.size - position))
        const { bytesRead } = await file.read(buffer, 0, buffer.length, position)
        if (!bytesRead) throw new Error('DUMP_CHANGED')
        position += bytesRead
        yield buffer.subarray(0, bytesRead)
      }
    })())
    await pipeline(source, child.stdin!)
  }, undefined, join(input.stagingDirectory, 'database.dump'))
  const after = await file.stat()
  if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) throw new Error('DUMP_CHANGED')
}

/** Decode an existing archive without connecting to or mutating PostgreSQL. */
export async function verifyPostgresDump(input: PostgresDumpTarget): Promise<void> {
  await validate(input)
  await assertPostgres18Tools(input)
  const file = await open(join(input.stagingDirectory, 'database.dump'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try { await verifyFile(input, file) } finally { await file.close() }
}

/** Decode only the two identity/migration tables as COPY text; never execute
 * the archive against any database. Caller must authenticate release metadata. */
export async function verifyPostgresDumpBinding(input: PostgresDumpTarget,
  expected: Awaited<ReturnType<typeof readBackupDatabaseMetadata>>): Promise<void> {
  await validate(input)
  await assertPostgres18Tools(input)
  const file = await open(join(input.stagingDirectory, 'database.dump'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat()
    if (!before.isFile() || before.nlink !== 1 || before.size < 5 || (before.mode & 0o077) !== 0) throw new Error('DUMP_INVALID')
    async function restoreRows(table: 'installation_binding' | 'kysely_migration', header: string): Promise<string[]> {
      let output = ''
      await docker(input, ['pg_restore', '--data-only', '--exit-on-error', '--table', table, '--file=-'], async child => {
        if (process.env.NODE_ENV === 'production' && process.env.AIKAYUN_BACKUP_HOST_BROKER === 'stdio-v1') {
          child.stdin!.end()
          const sink = new Writable({ write(chunk: Buffer, _encoding, callback) {
            if (output.length + chunk.length > 1024 * 1024) { callback(new Error('DUMP_BINDING_OUTPUT_LIMIT')); return }
            output += chunk.toString('utf8'); callback()
          } })
          await pipeline(child.stdout!, sink)
          return
        }
        const source = Readable.from((async function* () {
          let position = 0
          while (position < before.size) {
            const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, before.size - position))
            const result = await file.read(buffer, 0, buffer.length, position)
            if (!result.bytesRead) throw new Error('DUMP_CHANGED')
            position += result.bytesRead
            yield buffer.subarray(0, result.bytesRead)
          }
        })())
        const sink = new Writable({ write(chunk: Buffer, _encoding, callback) {
          if (output.length + chunk.length > 1024 * 1024) { callback(new Error('DUMP_BINDING_OUTPUT_LIMIT')); return }
          output += chunk.toString('utf8'); callback()
        } })
        await Promise.all([pipeline(source, child.stdin!), pipeline(child.stdout!, sink)])
      }, undefined, join(input.stagingDirectory, 'database.dump'))
      const lines = output.split('\n')
      const copies = lines.filter(line => line.startsWith('COPY '))
      if (copies.length !== 1 || copies[0] !== header) throw new Error('DUMP_BINDING_INVALID')
      const start = lines.indexOf(header) + 1
      const end = lines.indexOf('\\.', start)
      if (start < 1 || end < start) throw new Error('DUMP_BINDING_INVALID')
      return lines.slice(start, end)
    }
    const bindingRows = await restoreRows('installation_binding', 'COPY public.installation_binding (singleton, database_id, instance_id, identity_jkt, binding_revision, binding_state, created_at, pending_key_id, pending_key_sha256) FROM stdin;')
    if (bindingRows.length !== 1) throw new Error('DUMP_BINDING_MISMATCH')
    const values = bindingRows[0]!.split('\t')
    if (values.length !== 9 || values[0] !== 't' || values[1] !== expected.databaseId || values[2] !== expected.instanceId ||
        values[3] !== expected.identityJkt || values[5] !== 'ready' || values[7] !== expected.pendingKeyId ||
        values[8] !== expected.pendingKeySha256) throw new Error('DUMP_BINDING_MISMATCH')
    const rows = await restoreRows('kysely_migration', 'COPY public.kysely_migration (name, "timestamp") FROM stdin;')
    const names = rows.map(row => row.split('\t'))
    const expectedNames = Object.keys(await new AppMigrationProvider().getMigrations()).sort()
    const actualNames = names.map(row => row[0]).sort()
    if (names.some(row => row.length !== 2 || !row[1] || row[1].includes('\\')) || actualNames.length !== expectedNames.length ||
        actualNames.some((name, index) => name !== expectedNames[index]) || expectedNames.at(-1) !== expected.migrationHead) {
      throw new Error('DUMP_MIGRATIONS_MISMATCH')
    }
    const after = await file.stat()
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('DUMP_CHANGED')
  } finally { await file.close() }
}

/** Capture and fully decode the custom dump before returning it. The caller
 * owns the deployment lock, writer fence, staging encryption and crash cleanup. */
export async function capturePostgresDump(input: PostgresDumpTarget): Promise<{ size: number; sha256: string; pgDumpVersion: string }> {
  await validate(input)
  const pgDumpVersion = await assertPostgres18Tools(input)
  const path = join(input.stagingDirectory, 'database.dump')
  const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
  let success = false
  let unsafe = false
  let failure: unknown
  let result: { size: number; sha256: string; pgDumpVersion: string } | undefined
  try {
    const hash = createHash('sha256')
    let size = 0
    const destination = new Writable({ write(chunk: Buffer, _encoding, callback) {
      void (async () => {
        let offset = 0
        while (offset < chunk.length) {
          const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset, size + offset)
          if (!bytesWritten) throw new Error('DUMP_WRITE_FAILED')
          offset += bytesWritten
        }
        size += chunk.length
        hash.update(chunk)
      })().then(() => callback(), error => callback(error))
    } })
    const sessionName = `aikayun_backup_${randomUUID().replaceAll('-', '')}`
    try {
      await docker(input, ['pg_dump', '--format=custom', '--no-password', '--host=/var/run/postgresql', '--port=5432', `--username=${input.user}`, `--dbname=${input.database}`], async child => {
        child.stdin!.end()
        await pipeline(child.stdout!, destination)
      }, sessionName)
    } catch (error) {
      try { await stopDumpSession(input, sessionName) } catch { throw new UnsafeMaintenanceRecoveryError('DUMP_CLEANUP_UNVERIFIED') }
      throw error
    }
    if (!Number.isSafeInteger(size) || size < 5) throw new Error('DUMP_INVALID')
    await file.sync()
    await verifyFile(input, file)
    const stat = await file.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== size) throw new Error('DUMP_INVALID')
    success = true
    result = { size, sha256: hash.digest('hex'), pgDumpVersion }
  } catch (error) {
    if (error instanceof UnsafeMaintenanceRecoveryError) unsafe = true
    failure = error
  }
  try { await file.close() } catch { throw new UnsafeMaintenanceRecoveryError('DUMP_CLEANUP_UNVERIFIED') }
  if (!success && !unsafe) await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw new UnsafeMaintenanceRecoveryError('DUMP_CLEANUP_UNVERIFIED')
  })
  if (failure) throw failure
  if (!result) throw new Error('DUMP_INVALID')
  return result
}
