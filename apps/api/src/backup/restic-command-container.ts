import { randomUUID } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { UnsafeMaintenanceRecoveryError } from './maintenance-errors.js'
import { trustedAncestors, within } from './restic-local.js'
import { dockerExec, dockerSpawn } from './docker-client.js'

const imagePattern = /^ghcr\.io\/yykx682436\/aikayun-backup-restic@sha256:[a-f0-9]{64}$/
const idPattern = /^[a-f0-9]{64}$/

type OutputSink = { limit: number; write(chunk: Buffer): Promise<void> }
type Container = {
  Id?: unknown; Image?: unknown; Path?: unknown; Args?: unknown
  Config?: { Image?: unknown; User?: unknown; Labels?: Record<string, unknown> }
  State?: { Status?: unknown; ExitCode?: unknown; OOMKilled?: unknown }
  HostConfig?: {
    NetworkMode?: unknown; ReadonlyRootfs?: unknown; CapDrop?: unknown; CapAdd?: unknown; SecurityOpt?: unknown
    Tmpfs?: unknown; RestartPolicy?: { Name?: unknown }; AutoRemove?: unknown; Privileged?: unknown
    PidMode?: unknown; IpcMode?: unknown; Devices?: unknown; Binds?: unknown; VolumesFrom?: unknown
  }
  Mounts?: Array<{ Type?: unknown; Source?: unknown; Destination?: unknown; RW?: unknown }>
}

export type ResticCommandContainerTarget = {
  dockerBinary?: string
  dockerSocket?: string
  image: string
  repositoryDirectory: string
  passwordFile: string
  /** Random fixture-only Linux volume used when Docker Desktop cannot read a macOS source bind. */
  testSourceVolume?: string
  /** Fixture-only copier that stages the host source into testSourceVolume. */
  testPrepareSource?(source: string): Promise<void>
  /** Receives only a fixed diagnostic token projection in isolated tests. */
  testDiagnostic?(tokens: string): void
  assertLock(): Promise<void>
  signal?: AbortSignal
  timeoutMs?: number
}

function object(raw: string): Record<string, unknown> {
  let parsed: unknown
  try { parsed = JSON.parse(raw) as unknown } catch { throw new Error('RESTIC_CONTAINER_INSPECTION_INVALID') }
  if (!Array.isArray(parsed) || parsed.length !== 1 || !parsed[0] || typeof parsed[0] !== 'object' || Array.isArray(parsed[0])) {
    throw new Error('RESTIC_CONTAINER_INSPECTION_INVALID')
  }
  return parsed[0] as Record<string, unknown>
}

function empty(value: unknown): boolean {
  return value === null || value === undefined || (Array.isArray(value) && value.length === 0) ||
    (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0)
}

function bindSourceMatches(actual: unknown, expected: string): boolean {
  if (actual === expected) return true
  if (process.env.NODE_ENV === 'test' && process.platform === 'darwin' && typeof actual === 'string') {
    return actual === `/host_mnt${expected}`
  }
  return false
}

/** Runs repository commands in the digest selected by the authenticated release.
 * The Restic container receives no Docker socket or application data volumes. */
export class ResticCommandContainer {
  private readonly scope = 'com.aikayun.backup.restic-command'
  private imageIdentity = ''

  constructor(private readonly target: ResticCommandContainerTarget) {
    const localTestImage = process.env.NODE_ENV === 'test' && typeof target?.image === 'string' && /^sha256:[a-f0-9]{64}$/.test(target.image)
    const validTestSourceVolume = process.env.NODE_ENV === 'test' && typeof target?.testSourceVolume === 'string' &&
      /^aikayun-75a-test-[a-f0-9]{24}_(?:restic_manifest|reader_manifest)$/.test(target.testSourceVolume)
    const hostBroker = process.env.NODE_ENV === 'production' && process.env.AIKAYUN_BACKUP_HOST_BROKER === 'stdio-v1'
    if (!target || (!imagePattern.test(target.image) && !localTestImage) ||
        (!hostBroker && (!target.dockerBinary || !isAbsolute(target.dockerBinary) || resolve(target.dockerBinary) !== target.dockerBinary ||
          !target.dockerSocket || !isAbsolute(target.dockerSocket) || resolve(target.dockerSocket) !== target.dockerSocket)) ||
        !isAbsolute(target.repositoryDirectory) || resolve(target.repositoryDirectory) !== target.repositoryDirectory ||
        !isAbsolute(target.passwordFile) || resolve(target.passwordFile) !== target.passwordFile ||
        (target.testSourceVolume !== undefined && !validTestSourceVolume) ||
        (target.testPrepareSource !== undefined && (!validTestSourceVolume || typeof target.testPrepareSource !== 'function')) ||
        (target.testDiagnostic !== undefined && (process.env.NODE_ENV !== 'test' || typeof target.testDiagnostic !== 'function')) ||
        typeof target.assertLock !== 'function' || (target.timeoutMs !== undefined &&
          (!Number.isSafeInteger(target.timeoutMs) || target.timeoutMs < 100 || target.timeoutMs > 6 * 60 * 60 * 1000))) {
      throw new Error('RESTIC_CONTAINER_CONFIGURATION_INVALID')
    }
  }

  private async docker(args: string[], timeoutMs?: number): Promise<string> {
    await this.target.assertLock()
    if (this.target.signal?.aborted) throw new UnsafeMaintenanceRecoveryError('RESTIC_CONTAINER_INTERRUPTED')
    try {
      return (await dockerExec(this.target.dockerBinary, this.target.dockerSocket, args, {
        timeoutMs: timeoutMs ?? this.target.timeoutMs ?? 30_000,
        maxBuffer: 1024 * 1024, ...(this.target.signal ? { signal: this.target.signal } : {}),
      })).trim()
    } catch {
      if (this.target.signal?.aborted) throw new UnsafeMaintenanceRecoveryError('RESTIC_CONTAINER_INTERRUPTED')
      throw new Error('RESTIC_CONTAINER_DOCKER_FAILED')
    }
  }

  private async validate(source?: string): Promise<void> {
    const hostBroker = process.env.NODE_ENV === 'production' && process.env.AIKAYUN_BACKUP_HOST_BROKER === 'stdio-v1'
    const [docker, socket, repository, password] = await Promise.all([
      hostBroker ? Promise.resolve(undefined) : lstat(this.target.dockerBinary!),
      hostBroker ? Promise.resolve(undefined) : lstat(this.target.dockerSocket!),
      lstat(this.target.repositoryDirectory), lstat(this.target.passwordFile),
    ])
    const owner = process.getuid?.(), group = process.getgid?.()
    if (owner === undefined || group === undefined || (!hostBroker && (!docker!.isFile() || docker!.isSymbolicLink() || docker!.nlink !== 1 ||
        (docker!.mode & 0o022) !== 0 || (docker!.mode & 0o111) === 0 || (docker!.uid !== 0 && docker!.uid !== owner) ||
        !socket!.isSocket() || (socket!.uid !== 0 && socket!.uid !== owner))) || !repository.isDirectory() || repository.isSymbolicLink() ||
        (repository.uid !== owner && repository.uid !== 0) || (repository.gid !== group && repository.gid !== 0) || (repository.mode & 0o777) !== 0o700 ||
        !password.isFile() || password.isSymbolicLink() || password.nlink !== 1 || (password.uid !== owner && password.uid !== 0) ||
        (password.gid !== group && password.gid !== 0) ||
        (password.mode & 0o777) !== 0o600 || password.size < 1 || password.size > 4096 ||
        await realpath(this.target.repositoryDirectory) !== this.target.repositoryDirectory ||
        await realpath(this.target.passwordFile) !== this.target.passwordFile || within(this.target.repositoryDirectory, this.target.passwordFile) ||
        within(this.target.passwordFile, this.target.repositoryDirectory)) throw new Error('RESTIC_CONTAINER_PATH_INVALID')
    for (const path of [...(hostBroker ? [] : [this.target.dockerBinary!, this.target.dockerSocket!]), this.target.repositoryDirectory, this.target.passwordFile]) {
      await trustedAncestors(path)
    }
    if (source !== undefined) {
      const sourceStat = await lstat(source)
      if (!isAbsolute(source) || resolve(source) !== source || !sourceStat.isDirectory() || sourceStat.isSymbolicLink() ||
          sourceStat.uid !== owner || sourceStat.gid !== group || await realpath(source) !== source ||
          [source, this.target.repositoryDirectory, this.target.passwordFile].some(value => /[,\r\n\0]/.test(value)) ||
          within(this.target.repositoryDirectory, source) || within(source, this.target.repositoryDirectory) ||
          within(this.target.passwordFile, source) || within(source, this.target.passwordFile)) throw new Error('RESTIC_CONTAINER_SOURCE_INVALID')
      await trustedAncestors(source)
    }
    await this.target.assertLock()
  }

  private async existing(): Promise<string[]> {
    const output = await this.docker(['ps', '-a', '--quiet', '--no-trunc', '--filter', `label=${this.scope}=yes`], 15_000)
    const ids = output ? output.split(/\s+/) : []
    if (ids.some(id => !idPattern.test(id))) throw new UnsafeMaintenanceRecoveryError('RESTIC_CONTAINER_STATE_UNVERIFIED')
    return ids
  }

  private mounts(source?: string): string[] {
    return [
      `type=bind,source=${this.target.repositoryDirectory},target=/repo`,
      `type=bind,source=${this.target.passwordFile},target=/run/password,readonly`,
      ...(source ? [this.target.testSourceVolume
        ? `type=volume,source=${this.target.testSourceVolume},target=${source},readonly`
        : `type=bind,source=${source},target=${source},readonly`] : []),
    ]
  }

  private async assertTestSourceVolume(): Promise<void> {
    const name = this.target.testSourceVolume
    if (!name) return
    const project = name.replace(/_(?:restic_manifest|reader_manifest)$/, '')
    const volume = object(await this.docker(['volume', 'inspect', name])) as {
      Name?: unknown; Driver?: unknown; Scope?: unknown; Options?: unknown; Labels?: Record<string, unknown>
    }
    if (volume.Name !== name || volume.Driver !== 'local' || volume.Scope !== 'local' || !empty(volume.Options) ||
        volume.Labels?.['com.aikayun.fixture'] !== project ||
        volume.Labels?.['com.aikayun.backup.test-source'] !== 'manifest') throw new Error('RESTIC_CONTAINER_TEST_VOLUME_INVALID')
  }

  private async inspect(id: string): Promise<Container> {
    return object(await this.docker(['inspect', '--type', 'container', id])) as Container
  }

  private async waitForFinished(id: string): Promise<Container> {
    let delayMs = 50
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (this.target.signal?.aborted) throw new UnsafeMaintenanceRecoveryError('RESTIC_CONTAINER_INTERRUPTED')
      await this.target.assertLock()
      const container = await this.inspect(id)
      const status = container.State?.Status
      if (status === 'exited') return container
      if (status !== 'created' && status !== 'running') {
        throw new UnsafeMaintenanceRecoveryError('RESTIC_CONTAINER_STATE_UNCERTAIN')
      }
      if (attempt < 19) {
        await new Promise<void>(resolve => setTimeout(resolve, delayMs))
        delayMs = Math.min(delayMs * 2, 500)
      }
    }
    throw new UnsafeMaintenanceRecoveryError('RESTIC_CONTAINER_STATE_UNCERTAIN')
  }

  private async verifyCreated(id: string, operation: string, command: string[], source?: string): Promise<void> {
    const container = await this.inspect(id)
    const labels = container.Config?.Labels
    const host = container.HostConfig
    if (container.Id !== id || container.Image !== this.imageIdentity || container.Config?.Image !== this.target.image ||
        container.Config?.User !== '0:0' || container.Path !== '/usr/bin/restic' ||
        JSON.stringify(container.Args) !== JSON.stringify(command) || container.State?.Status !== 'created' ||
        labels?.[this.scope] !== 'yes' || labels?.['com.aikayun.backup.restic-operation'] !== operation ||
        host?.NetworkMode !== 'none' || host.ReadonlyRootfs !== true || JSON.stringify(host.CapDrop) !== JSON.stringify(['ALL']) ||
        JSON.stringify(host.CapAdd) !== JSON.stringify(['CAP_DAC_READ_SEARCH']) || JSON.stringify(host.SecurityOpt) !== JSON.stringify(['no-new-privileges:true']) ||
        JSON.stringify(host.Tmpfs) !== JSON.stringify({ '/tmp': 'rw,noexec,nosuid,nodev,size=64m' }) ||
        host.RestartPolicy?.Name !== 'no' || host.AutoRemove !== false || host.Privileged !== false ||
        (host.PidMode !== '' && host.PidMode !== undefined) || (host.IpcMode !== '' && host.IpcMode !== 'private') ||
        !empty(host.Devices) || !empty(host.Binds) || !empty(host.VolumesFrom)) throw new Error('RESTIC_CONTAINER_PROFILE_INVALID')
    const expected = new Map<string, { type: string; source: string; writable: boolean }>([
      ['/repo', { type: 'bind', source: this.target.repositoryDirectory, writable: true }],
      ['/run/password', { type: 'bind', source: this.target.passwordFile, writable: false }],
      ...(source ? [[source, { type: this.target.testSourceVolume ? 'volume' : 'bind',
        source: this.target.testSourceVolume ?? source, writable: false }] as const] : []),
    ])
    if (!Array.isArray(container.Mounts) || container.Mounts.length !== expected.size) throw new Error('RESTIC_CONTAINER_MOUNTS_INVALID')
    for (const mount of container.Mounts) {
      if (typeof mount.Destination !== 'string') throw new Error('RESTIC_CONTAINER_MOUNTS_INVALID')
      const spec = expected.get(mount.Destination)
      const actualSource = spec?.type === 'volume' ? (mount as typeof mount & { Name?: unknown }).Name : mount.Source
      if (!spec || mount.Type !== spec.type ||
          !(spec.type === 'volume' ? actualSource === spec.source : bindSourceMatches(actualSource, spec.source)) || mount.RW !== spec.writable ||
          mount.Destination === '/run/docker.sock') throw new Error('RESTIC_CONTAINER_MOUNTS_INVALID')
    }
  }

  private async remove(id: string, operation: string): Promise<void> {
    const container = await this.inspect(id)
    if (container.Id !== id || container.Config?.Labels?.[this.scope] !== 'yes' ||
        container.Config?.Labels?.['com.aikayun.backup.restic-operation'] !== operation ||
        (container.State?.Status !== 'exited' && container.State?.Status !== 'created')) {
      throw new UnsafeMaintenanceRecoveryError('RESTIC_CONTAINER_CLEANUP_UNVERIFIED')
    }
    await this.docker(['rm', id], 15_000)
    if ((await this.existing()).length !== 0) throw new UnsafeMaintenanceRecoveryError('RESTIC_CONTAINER_CLEANUP_UNVERIFIED')
  }

  async execute(args: string[], source?: string, sink?: OutputSink): Promise<string> {
    if (this.target.signal?.aborted || !Array.isArray(args) || args.length === 0 || args.length > 32 ||
        args.some(value => typeof value !== 'string' || value.length > 4096 || value.includes('\0')) ||
        (sink !== undefined && (!Number.isSafeInteger(sink.limit) || sink.limit < 1 || typeof sink.write !== 'function'))) {
      throw new Error('RESTIC_CONTAINER_ARGUMENT_INVALID')
    }
    await this.validate(source)
    if (source && this.target.testSourceVolume) {
      await this.assertTestSourceVolume()
      await this.target.testPrepareSource?.(source)
    }
    if ((await this.existing()).length !== 0) throw new UnsafeMaintenanceRecoveryError('RESTIC_CONTAINER_STALE_OPERATION')
    const operation = randomUUID()
    const name = `aikayun-restic-cmd-${operation}`
    const command = ['--repo', '/repo', '--password-file', '/run/password', '--no-cache', '--quiet', ...args]
    const create = ['create', '--pull=never', '--name', name, '--label', `${this.scope}=yes`,
      '--label', `com.aikayun.backup.restic-operation=${operation}`, '--network', 'none', '--read-only',
      '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m', '--cap-drop', 'ALL', '--cap-add', 'DAC_READ_SEARCH',
      '--security-opt', 'no-new-privileges:true', '--user', '0:0',
      ...this.mounts(source).flatMap(mount => ['--mount', mount]), '--entrypoint', '/usr/bin/restic',
      this.target.image, ...command]
    let id: string | undefined
    let output = ''
    let stderr = Buffer.alloc(0)
    let bytes = 0
    let timedOut = false, interrupted = false, overLimit = false, sinkFailed = false
    let childError = false
    let createAttempted = false
    let startAttempted = false
    let failure: unknown
    let attachExitCode: number | null | undefined
    try {
      await this.target.assertLock()
      createAttempted = true
      const created = await this.docker(create, this.target.timeoutMs ?? 30_000)
      id = created.trim()
      if (!idPattern.test(id)) throw new UnsafeMaintenanceRecoveryError('RESTIC_CONTAINER_CREATE_UNCERTAIN')
      await this.target.assertLock()
      await this.verifyCreated(id, operation, command, source)
      if (this.target.signal?.aborted) throw new Error('RESTIC_CONTAINER_INTERRUPTED')
      startAttempted = true
      const child = dockerSpawn(this.target.dockerBinary, this.target.dockerSocket, ['start', '--attach', id], {
        ...(this.target.signal ? { signal: this.target.signal } : {}), maxBytes: sink?.limit ?? 1024 * 1024,
      })
      let pending = Promise.resolve()
      let killTimer: ReturnType<typeof setTimeout> | undefined
      const stop = () => {
        child.kill('SIGTERM')
        killTimer ??= setTimeout(() => child.kill('SIGKILL'), 2000)
      }
      const abort = () => { interrupted = true; stop() }
      this.target.signal?.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(() => { timedOut = true; stop() }, this.target.timeoutMs ?? 6 * 60 * 60 * 1000)
      child.stdout!.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > (sink?.limit ?? 1024 * 1024)) { overLimit = true; stop(); return }
        if (!sink) { output += chunk.toString('utf8'); return }
        child.stdout!.pause()
        pending = pending.then(() => sink.write(chunk)).then(() => { child.stdout!.resume() }, () => {
          sinkFailed = true; stop(); child.stdout!.resume()
        })
      })
      child.stderr!.on('data', (chunk: Buffer) => {
        if (stderr.length < 64 * 1024) stderr = Buffer.concat([stderr, chunk.subarray(0, 64 * 1024 - stderr.length)])
      })
      await new Promise<void>((resolve, reject) => {
        child.once('error', () => { childError = true; reject(new Error('RESTIC_CONTAINER_START_FAILED')) })
        child.once('close', code => { attachExitCode = typeof code === 'number' ? code : null; resolve() })
      }).catch(error => { failure = error })
      await pending
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      this.target.signal?.removeEventListener('abort', abort)
      if (timedOut || interrupted || overLimit || sinkFailed || childError || failure) {
        throw new UnsafeMaintenanceRecoveryError(timedOut ? 'RESTIC_CONTAINER_TIMEOUT' : interrupted ? 'RESTIC_CONTAINER_INTERRUPTED' :
          overLimit ? 'RESTIC_CONTAINER_OUTPUT_LIMIT' : sinkFailed ? 'RESTIC_CONTAINER_SINK_FAILED' :
          childError ? 'RESTIC_CONTAINER_CLIENT_FAILED' : 'RESTIC_CONTAINER_RESULT_UNCERTAIN')
      }
      await this.target.assertLock()
      const finished = await this.waitForFinished(id)
      if (finished.State?.Status !== 'exited' || finished.State.ExitCode !== 0 || finished.State.OOMKilled !== false) {
        if (finished.State?.Status === 'exited') this.target.testDiagnostic?.(this.safeDiagnostic(stderr))
        await this.remove(id, operation)
        id = undefined
        const commandFailure = new Error('RESTIC_COMMAND_FAILED')
        const operationCode = args[0] && /^[a-z]{1,32}$/.test(args[0]) ? args[0].toUpperCase() : 'UNKNOWN'
        Object.defineProperty(commandFailure, 'operationCode', { value: `RESTIC_${operationCode}_FAILED`, enumerable: true })
        throw commandFailure
      }
      if (attachExitCode !== 0) {
        throw new UnsafeMaintenanceRecoveryError(typeof attachExitCode === 'number'
          ? 'RESTIC_CONTAINER_ATTACH_FAILED' : 'RESTIC_CONTAINER_ATTACH_STATUS_UNKNOWN')
      }
      await this.remove(id, operation)
      id = undefined
      return output
    } catch (error) { failure = error }

    if (createAttempted && id === undefined) {
      const found = await this.existing().catch(() => { throw new UnsafeMaintenanceRecoveryError('RESTIC_CONTAINER_CLEANUP_UNVERIFIED') })
      if (found.length > 0) {
        if (found.length !== 1) throw new UnsafeMaintenanceRecoveryError('RESTIC_CONTAINER_CLEANUP_UNVERIFIED')
        const candidate = await this.inspect(found[0]!).catch(() => { throw new UnsafeMaintenanceRecoveryError('RESTIC_CONTAINER_CLEANUP_UNVERIFIED') })
        if (candidate.Config?.Labels?.['com.aikayun.backup.restic-operation'] !== operation) {
          throw new UnsafeMaintenanceRecoveryError('RESTIC_CONTAINER_CLEANUP_UNVERIFIED')
        }
        if (candidate.State?.Status === 'created' && !startAttempted) await this.remove(found[0]!, operation)
        else throw new UnsafeMaintenanceRecoveryError('RESTIC_CONTAINER_RESULT_UNCERTAIN')
      }
    } else if (id) {
      const state = await this.inspect(id).catch(() => { throw new UnsafeMaintenanceRecoveryError('RESTIC_CONTAINER_RESULT_UNCERTAIN') })
      if (state.State?.Status === 'created' && !startAttempted) await this.remove(id, operation)
      else if (state.State?.Status === 'exited' && !timedOut && !interrupted && !overLimit && !sinkFailed && !childError) {
        await this.remove(id, operation)
      } else if (state.State?.Status === 'exited' && (timedOut || interrupted || overLimit || sinkFailed || childError)) {
        await this.remove(id, operation)
        throw new UnsafeMaintenanceRecoveryError(timedOut ? 'RESTIC_CONTAINER_TIMEOUT' : interrupted ? 'RESTIC_CONTAINER_INTERRUPTED' :
          overLimit ? 'RESTIC_CONTAINER_OUTPUT_LIMIT' : sinkFailed ? 'RESTIC_CONTAINER_SINK_FAILED' : 'RESTIC_CONTAINER_CLIENT_FAILED')
      } else if (state.State?.Status === 'running' && (timedOut || interrupted || overLimit || sinkFailed || childError)) {
        throw new UnsafeMaintenanceRecoveryError(timedOut ? 'RESTIC_CONTAINER_TIMEOUT' : interrupted ? 'RESTIC_CONTAINER_INTERRUPTED' :
          overLimit ? 'RESTIC_CONTAINER_OUTPUT_LIMIT' : sinkFailed ? 'RESTIC_CONTAINER_SINK_FAILED' : 'RESTIC_CONTAINER_CLIENT_FAILED')
      } else throw new UnsafeMaintenanceRecoveryError('RESTIC_CONTAINER_RESULT_UNCERTAIN')
    }
    if (failure instanceof UnsafeMaintenanceRecoveryError) throw failure
    if (failure instanceof Error && /^RESTIC_CONTAINER_[A-Z_]+$/.test(failure.message)) throw failure
    const operationCode = args[0] && /^[a-z]{1,32}$/.test(args[0]) ? args[0].toUpperCase() : 'UNKNOWN'
    const commandFailure = new Error('RESTIC_COMMAND_FAILED')
    Object.defineProperty(commandFailure, 'operationCode', { value: `RESTIC_${operationCode}_FAILED`, enumerable: true })
    void stderr
    throw commandFailure
  }

  private safeDiagnostic(stderr: Buffer): string {
    const allowed = new Set('fatal error failed unable to open read write create find backup snapshot repository config password invalid source no such file directory already locked permission denied operation not permitted input output during archival item could not be loaded restored checksum'.split(' '))
    const tokens = (stderr.toString('utf8').toLowerCase().match(/[a-z]+/g) ?? []).filter(token => allowed.has(token))
    return [...new Set(tokens)].slice(0, 20).join('-') || 'unknown'
  }

  async initialize(): Promise<void> {
    await this.target.assertLock()
    const value = object(await this.docker(['image', 'inspect', this.target.image]))
    if (typeof value.Id !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.Id)) throw new Error('RESTIC_CONTAINER_IMAGE_INVALID')
    this.imageIdentity = value.Id
    await this.target.assertLock()
  }
}
