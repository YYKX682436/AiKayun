import { randomUUID } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import { UnsafeMaintenanceRecoveryError } from './maintenance-errors.js'
import { trustedAncestors, within } from './restic-local.js'
import { dockerExec, dockerSpawn } from './docker-client.js'

const setIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const digestImage = /^ghcr\.io\/yykx682436\/aikayun-backup-restic@sha256:[a-f0-9]{64}$/
const localTestImage = /^sha256:[a-f0-9]{64}$/
const UUID = () => randomUUID()
const maximumResticEventBytes = 64 * 1024

type Volume = { Name?: unknown; Driver?: unknown; Scope?: unknown; Labels?: unknown; Options?: unknown }
type ReaderInspect = {
  Id?: unknown; Image?: unknown; Path?: unknown; Args?: unknown
  Config?: { Image?: unknown; User?: unknown; Labels?: Record<string, unknown> }
  State?: { Status?: unknown; ExitCode?: unknown; OOMKilled?: unknown }
  HostConfig?: { NetworkMode?: unknown; ReadonlyRootfs?: unknown; CapDrop?: unknown; CapAdd?: unknown; SecurityOpt?: unknown; Tmpfs?: unknown; RestartPolicy?: { Name?: unknown } }
  Mounts?: Array<{ Type?: unknown; Name?: unknown; Source?: unknown; Destination?: unknown; RW?: unknown }>
}

export interface DirectResticCaptureTarget {
  /** Direct CLI fields are accepted only by isolated tests. */
  dockerBinary?: string
  dockerSocket?: string
  /** Digest reference authenticated by the signed release manifest. */
  image: string
  repositoryDirectory: string
  passwordFile: string
  /** The set directory on the coordinator's already verified noswap tmpfs. */
  stagingDirectory: string
  deploymentRoot: string
  backupSetId: string
  /** Randomly named Compose-equivalent volumes, accepted only in isolated tests. */
  testSourceVolumes?: { state: string; caddyData: string; caddyConfig: string }
  /** Docker Desktop integration tests use Linux volumes for bind sources. */
  testStagingVolume?: string
  testDeploymentVolume?: string
  /** Receives only a fixed-token projection of Restic stderr during isolated diagnostics. */
  testDiagnostic?: (tokens: string) => void
  assertLock(): Promise<void>
  signal?: AbortSignal | undefined
  timeoutMs?: number | undefined
}

function parseJson(raw: string): unknown {
  try { return JSON.parse(raw) as unknown } catch { throw new Error('RESTIC_READER_INSPECTION_INVALID') }
}

function oneObject(raw: string): Record<string, unknown> {
  const value = parseJson(raw)
  if (!Array.isArray(value) || value.length !== 1 || !value[0] || typeof value[0] !== 'object' || Array.isArray(value[0])) {
    throw new Error('RESTIC_READER_INSPECTION_INVALID')
  }
  return value[0] as Record<string, unknown>
}

async function validatePath(path: string, kind: 'file' | 'directory' | 'socket', owner?: number): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path) throw new Error('RESTIC_READER_PATH_INVALID')
  const item = await lstat(path)
  if ((kind === 'file' ? !item.isFile() : kind === 'directory' ? !item.isDirectory() : !item.isSocket()) || item.isSymbolicLink() ||
      (owner !== undefined && item.uid !== owner)) throw new Error('RESTIC_READER_PATH_INVALID')
  await trustedAncestors(path)
}

function emptyOptions(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0)
}
function emptyList(value: unknown): boolean { return value === null || value === undefined || (Array.isArray(value) && value.length === 0) }

function resticFailureCode(stderr: Buffer): string {
  const text = stderr.toString('utf8').toLowerCase()
  if (text.includes('permission denied') || text.includes('operation not permitted')) return 'RESTIC_READER_SOURCE_PERMISSION_DENIED'
  if (text.includes('no space left on device')) return 'RESTIC_READER_STORAGE_FULL'
  if (text.includes('no such file or directory')) return 'RESTIC_READER_SOURCE_MISSING'
  if (text.includes('incorrect password') || text.includes('wrong password')) return 'RESTIC_READER_PASSWORD_REJECTED'
  if (text.includes('unable to create lock') || text.includes('already locked')) return 'RESTIC_READER_LOCK_FAILED'
  if (text.includes('unable to open config file') || text.includes('failed to load config')) return 'RESTIC_READER_REPOSITORY_CONFIG_FAILED'
  if (text.includes('unable to save snapshot') || text.includes('unable to save')) return 'RESTIC_READER_REPOSITORY_WRITE_FAILED'
  if (text.includes('unable to read') || text.includes('could not read') || text.includes('error reading')) return 'RESTIC_READER_SOURCE_READ_FAILED'
  if (text.includes('invalid source') || text.includes('source path')) return 'RESTIC_READER_SOURCE_INVALID'
  if (text.includes('repository') && (text.includes('does not exist') || text.includes('not initialized'))) return 'RESTIC_READER_REPOSITORY_INVALID'
  if (text.includes('fatal:')) return 'RESTIC_READER_FATAL'
  return stderr.length ? 'RESTIC_READER_EXIT_DIAGNOSTIC' : 'RESTIC_READER_EXIT_NONZERO'
}

function safeDiagnosticTokens(stderr: Buffer): string {
  const text = stderr.toString('utf8').toLowerCase()
  const allowed = new Set('fatal error failed unable to open read write create find restore backup snapshot repository config password invalid source no such file directory already locked permission denied operation not permitted space full lock stat lstat mkdir save load path cannot could does exist found parent data cache metadata pack readable blocked read only stale bad descriptor checksum unsupported'.split(' '))
  const tokens = (text.match(/[a-z]+/g) ?? []).filter(token => allowed.has(token))
  const source = text.includes('/sources/state') ? 'state' : text.includes('/sources/caddy-data') ? 'caddy-data' :
    text.includes('/sources/caddy-config') ? 'caddy-config' : text.includes('/sources/deployment') ? 'deployment' :
      text.includes('/sources/staging') ? 'staging' : 'unknown-source'
  return [source, ...new Set([...tokens.slice(0, 8), ...tokens.slice(-10)])].join('-')
}

function bindSourceMatches(actual: unknown, expected: string): boolean {
  if (actual === expected) return true
  if (process.env.NODE_ENV === 'test' && process.platform === 'darwin' && typeof actual === 'string') {
    try { return actual === `/host_mnt${realpathSync(expected)}` } catch { return false }
  }
  return false
}

/**
 * Runs the data-reading portion of a production backup in a separate Restic
 * container. Docker operations are relayed to the signed host command over
 * stdio; this API helper and the Restic container receive no Docker socket.
 * The reader gets only fixed read-only sources, the encrypted repository, and
 * the password file. It never gets PostgreSQL data volume.
 */
export class DirectResticVolumeReader {
  private readonly operationLabel: string
  private readonly containerName: string
  private created = false
  private readonly imageId: string

  private constructor(private readonly target: DirectResticCaptureTarget, imageId: string,
    private readonly sourceVolumes: { state: string; caddyData: string; caddyConfig: string }) {
    this.imageId = imageId
    this.operationLabel = `com.aikayun.backup.restic-set=${target.backupSetId}`
    this.containerName = `aikayun-restic-read-${UUID()}`
  }

  static async create(target: DirectResticCaptureTarget): Promise<DirectResticVolumeReader> {
    const testImage = process.env.NODE_ENV === 'test' && typeof target?.image === 'string' && localTestImage.test(target.image)
    const sourceVolumes = target?.testSourceVolumes ?? { state: 'aikayun_state', caddyData: 'aikayun_caddy_data', caddyConfig: 'aikayun_caddy_config' }
    const testVolumes = process.env.NODE_ENV === 'test' && target?.testSourceVolumes !== undefined &&
      [sourceVolumes.state, sourceVolumes.caddyData, sourceVolumes.caddyConfig].every(name =>
        /^aikayun-75a-test-[a-f0-9]{24}_(?:aikayun_state|caddy_data|caddy_config)$/.test(name)) &&
      sourceVolumes.state.endsWith('_aikayun_state') && sourceVolumes.caddyData.endsWith('_caddy_data') &&
      sourceVolumes.caddyConfig.endsWith('_caddy_config') &&
      sourceVolumes.state.slice(0, -'_aikayun_state'.length) === sourceVolumes.caddyData.slice(0, -'_caddy_data'.length) &&
      sourceVolumes.state.slice(0, -'_aikayun_state'.length) === sourceVolumes.caddyConfig.slice(0, -'_caddy_config'.length)
    const projectPrefix = sourceVolumes.state.slice(0, -'_aikayun_state'.length)
    const testStorageVolumes = process.env.NODE_ENV === 'test' && typeof target?.testStagingVolume === 'string' &&
      typeof target.testDeploymentVolume === 'string' && target.testStagingVolume === `${projectPrefix}_reader_staging` &&
      target.testDeploymentVolume === `${projectPrefix}_reader_deployment`
    if (!target || !setIdPattern.test(target.backupSetId) || (!digestImage.test(target.image) && !testImage) ||
        (target.testSourceVolumes !== undefined && !testVolumes) ||
        ((target.testStagingVolume !== undefined || target.testDeploymentVolume !== undefined) && !testStorageVolumes) ||
        (target.testDiagnostic !== undefined && process.env.NODE_ENV !== 'test') ||
        !isAbsolute(target.stagingDirectory) || resolve(target.stagingDirectory) !== target.stagingDirectory ||
        (target.timeoutMs !== undefined && (!Number.isSafeInteger(target.timeoutMs) || target.timeoutMs < 100 || target.timeoutMs > 6 * 60 * 60 * 1000)) ||
        target.signal?.aborted || typeof target.assertLock !== 'function') throw new Error('RESTIC_READER_CONFIGURATION_INVALID')
    const owner = process.getuid?.()
    const group = process.getgid?.()
    if (owner === undefined || owner < 0 || group === undefined || group < 0) throw new Error('RESTIC_READER_CONFIGURATION_INVALID')
    const broker = process.env.NODE_ENV === 'production' && process.env.AIKAYUN_BACKUP_HOST_BROKER === 'stdio-v1'
    await Promise.all([
      ...(broker ? [] : [validatePath(target.dockerBinary!, 'file'), validatePath(target.dockerSocket!, 'socket')]),
      validatePath(target.repositoryDirectory, 'directory', owner), validatePath(target.passwordFile, 'file', owner),
      validatePath(target.deploymentRoot, 'directory', owner), validatePath(target.stagingDirectory, 'directory', owner),
    ])
    if (within(target.repositoryDirectory, target.deploymentRoot) || within(target.deploymentRoot, target.repositoryDirectory) ||
        within(target.repositoryDirectory, target.passwordFile) || within(target.passwordFile, target.repositoryDirectory) ||
        within(target.passwordFile, target.deploymentRoot) || within(target.deploymentRoot, target.passwordFile) ||
        within(target.repositoryDirectory, target.stagingDirectory) || within(target.stagingDirectory, target.repositoryDirectory) ||
        within(target.passwordFile, target.stagingDirectory) || within(target.stagingDirectory, target.passwordFile) ||
        within(target.deploymentRoot, target.stagingDirectory) || within(target.stagingDirectory, target.deploymentRoot)) {
      throw new Error('RESTIC_READER_STORAGE_OVERLAP')
    }
    const [repo, password, stage, payload] = await Promise.all([lstat(target.repositoryDirectory), lstat(target.passwordFile),
      lstat(target.stagingDirectory), lstat(join(target.stagingDirectory, 'payload'))])
    if ((repo.mode & 0o777) !== 0o700 || repo.gid !== group ||
        (repo.uid !== 0 && repo.uid !== owner) || password.uid !== owner || password.nlink !== 1 || password.size < 1 || password.size > 4096 || password.gid !== group ||
        (password.mode & 0o777) !== 0o600 || !stage.isDirectory() || stage.isSymbolicLink() || stage.uid !== owner ||
        (stage.mode & 0o777) !== 0o700 || !payload.isDirectory() || payload.isSymbolicLink() || payload.uid !== owner ||
        (payload.mode & 0o777) !== 0o700 || target.signal?.aborted) throw new Error('RESTIC_READER_PATH_INVALID')
    if (!broker) {
      const binaryPath = target.dockerBinary!, socketPath = target.dockerSocket!
      const [binary, socket] = await Promise.all([lstat(binaryPath), lstat(socketPath)])
      if (!binary.isFile() || binary.nlink !== 1 || (binary.mode & 0o022) !== 0 || (binary.mode & 0o111) === 0 ||
          (binary.uid !== 0 && binary.uid !== owner) || !socket.isSocket() || (socket.uid !== 0 && socket.uid !== owner)) {
        throw new Error('RESTIC_READER_PATH_INVALID')
      }
    }
    const reader = new DirectResticVolumeReader(target, '', sourceVolumes)
    await target.assertLock()
    const image = oneObject(await reader.docker(['image', 'inspect', target.image], false))
    if (typeof image.Id !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(image.Id)) throw new Error('RESTIC_READER_IMAGE_INVALID')
    const result = new DirectResticVolumeReader(target, image.Id, sourceVolumes)
    await Promise.all([
      result.assertVolume(sourceVolumes.state, 'com.aikayun.managed-by', 'aikayun-7-3'),
      result.assertVolume(sourceVolumes.caddyData, 'com.docker.compose.volume', 'caddy_data', 'aikayun'),
      result.assertVolume(sourceVolumes.caddyConfig, 'com.docker.compose.volume', 'caddy_config', 'aikayun'),
      ...(target.testStagingVolume ? [result.assertVolume(target.testStagingVolume, 'com.docker.compose.volume', 'backup_staging', 'aikayun')] : []),
      ...(target.testDeploymentVolume ? [result.assertVolume(target.testDeploymentVolume, 'com.docker.compose.volume', 'backup_deployment', 'aikayun')] : []),
    ])
    await target.assertLock()
    return result
  }

  private async docker(args: string[], safeToRetry = true): Promise<string> {
    await this.target.assertLock()
    if (this.target.signal?.aborted) throw new UnsafeMaintenanceRecoveryError('RESTIC_READER_INTERRUPTED')
    try {
      return (await dockerExec(this.target.dockerBinary, this.target.dockerSocket, args, {
        timeoutMs: this.target.timeoutMs ?? 30_000, maxBuffer: 1024 * 1024,
        ...(this.target.signal ? { signal: this.target.signal } : {}),
      })).trim()
    } catch {
      if (!safeToRetry) throw new UnsafeMaintenanceRecoveryError('RESTIC_READER_RESULT_UNCERTAIN')
      throw new Error('RESTIC_READER_DOCKER_FAILED')
    }
  }

  /** Drain progress without retaining it: it can contain customer filenames. */
  private async startAndReadSummary(id: string): Promise<string> {
    const child = dockerSpawn(this.target.dockerBinary, this.target.dockerSocket, ['start', '--attach', id], {
      ...(this.target.signal ? { signal: this.target.signal } : {}), maxBytes: 1024 * 1024,
    })
    let stderr = Buffer.alloc(0)
    child.stderr!.on('data', (chunk: Buffer) => {
      if (stderr.length < maximumResticEventBytes) stderr = Buffer.concat([stderr, chunk.subarray(0, maximumResticEventBytes - stderr.length)])
    })
    let pending = Buffer.alloc(0)
    let snapshotId: string | undefined
    let protocolError = false
    let interrupted = false
    let timedOut = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const stop = () => {
      child.kill('SIGTERM')
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 2000)
    }
    const abort = () => { interrupted = true; stop() }
    this.target.signal?.addEventListener('abort', abort, { once: true })
    if (this.target.signal?.aborted) abort()
    const timer = setTimeout(() => { timedOut = true; stop() }, this.target.timeoutMs ?? 6 * 60 * 60 * 1000)
    const parseLine = (line: Buffer) => {
      if (line.length === 0) return
      if (line.length > maximumResticEventBytes) { protocolError = true; stop(); return }
      let event: unknown
      try { event = JSON.parse(line.toString('utf8')) as unknown } catch { protocolError = true; stop(); return }
      if (!event || typeof event !== 'object' || Array.isArray(event) || !('message_type' in event) || typeof event.message_type !== 'string') {
        protocolError = true; stop(); return
      }
      if (event.message_type === 'error' || event.message_type === 'exit_error') protocolError = true
      if (event.message_type === 'summary' && 'snapshot_id' in event && typeof event.snapshot_id === 'string' &&
          /^[a-f0-9]{8,64}$/.test(event.snapshot_id)) snapshotId = event.snapshot_id
    }
    child.stdout!.on('data', (chunk: Buffer) => {
      let data = pending.length ? Buffer.concat([pending, chunk]) : chunk
      pending = Buffer.alloc(0)
      while (true) {
        const newline = data.indexOf(0x0a)
        if (newline < 0) break
        parseLine(data.subarray(0, newline))
        data = data.subarray(newline + 1)
      }
      if (data.length > maximumResticEventBytes) { protocolError = true; stop() }
      else pending = Buffer.from(data)
    })
    return new Promise<string>((accept, reject) => {
      let spawnFailed = false
      child.once('error', () => { spawnFailed = true })
      child.once('close', code => {
        clearTimeout(timer)
        this.target.signal?.removeEventListener('abort', abort)
        if (killTimer) clearTimeout(killTimer)
        if (pending.length) parseLine(pending)
        if (interrupted || timedOut) reject(new UnsafeMaintenanceRecoveryError('RESTIC_READER_RESULT_UNCERTAIN'))
        else if (spawnFailed) reject(new Error('RESTIC_READER_START_FAILED'))
        else if (protocolError) reject(new Error('RESTIC_READER_PROTOCOL_INVALID'))
        else if (code !== 0) {
          this.target.testDiagnostic?.(safeDiagnosticTokens(stderr))
          reject(new Error(resticFailureCode(stderr)))
        }
        else if (!snapshotId) reject(new Error('RESTIC_READER_SNAPSHOT_MISSING'))
        else accept(snapshotId)
      })
    })
  }

  private async assertVolume(name: string, label: string, value: string, project?: string): Promise<void> {
    const raw = parseJson(await this.docker(['volume', 'inspect', name]))
    if (!Array.isArray(raw) || raw.length !== 1 || !raw[0] || typeof raw[0] !== 'object') throw new Error('RESTIC_READER_VOLUME_INVALID')
    const volume = raw[0] as Volume
    const labels = volume.Labels as Record<string, unknown> | undefined
    if (volume.Name !== name || volume.Driver !== 'local' || volume.Scope !== 'local' || !emptyOptions(volume.Options) ||
        !labels || labels[label] !== value || (project && labels['com.docker.compose.project'] !== project)) {
      throw new Error('RESTIC_READER_VOLUME_INVALID')
    }
  }

  private mounts(): string[] {
    const stagingMount = this.target.testStagingVolume
      ? `type=volume,source=${this.target.testStagingVolume},target=/sources/staging,readonly`
      : `type=bind,source=${this.target.stagingDirectory},target=/sources/staging,readonly`
    const deploymentMount = this.target.testDeploymentVolume
      ? `type=volume,source=${this.target.testDeploymentVolume},target=/sources/deployment,readonly`
      : `type=bind,source=${this.target.deploymentRoot},target=/sources/deployment,readonly`
    const mounts = [
      `type=volume,source=${this.sourceVolumes.state},target=/sources/state,readonly`,
      `type=volume,source=${this.sourceVolumes.caddyData},target=/sources/caddy-data,readonly`,
      `type=volume,source=${this.sourceVolumes.caddyConfig},target=/sources/caddy-config,readonly`,
      stagingMount,
      deploymentMount,
      `type=bind,source=${this.target.repositoryDirectory},target=/repo`,
      `type=bind,source=${this.target.passwordFile},target=/run/password,readonly`,
    ]
    if (mounts.some(item => item.includes(',') && item.split(',').some(field => field.includes('\n') || field.includes('\0')))) {
      throw new Error('RESTIC_READER_MOUNT_INVALID')
    }
    return mounts
  }

  private async verifyCreated(id: string, command: string[]): Promise<void> {
    const out = await this.docker(['inspect', '--type', 'container', '--format',
      '{{json .Id}}\t{{json .Image}}\t{{json .Config.Image}}\t{{json .Config.User}}\t{{json .Config.Labels}}\t{{json .Path}}\t{{json .Args}}\t{{json .State.Status}}\t{{json .HostConfig.NetworkMode}}\t{{json .HostConfig.ReadonlyRootfs}}\t{{json .HostConfig.CapDrop}}\t{{json .HostConfig.CapAdd}}\t{{json .HostConfig.SecurityOpt}}\t{{json .HostConfig.Tmpfs}}\t{{json .HostConfig.RestartPolicy.Name}}\t{{json .HostConfig.AutoRemove}}\t{{json .HostConfig.Privileged}}\t{{json .HostConfig.PidMode}}\t{{json .HostConfig.IpcMode}}\t{{json .HostConfig.Devices}}\t{{json .HostConfig.Binds}}\t{{json .HostConfig.VolumesFrom}}\t{{json .Mounts}}', id])
    let fields: unknown[]
    try { fields = out.split('\t').map(part => JSON.parse(part) as unknown) } catch { throw new Error('RESTIC_READER_INSPECTION_INVALID') }
    const [actual, imageId, imageRef, user, labels, path, args, state, network, readOnly, capDrop, capAdd, security, tmpfs, restart,
      autoRemove, privileged, pidMode, ipcMode, devices, binds, volumesFrom, mounts] = fields
    if (fields.length !== 23 || actual !== id || imageId !== this.imageId || imageRef !== this.target.image || user !== '0:0' ||
        !labels || typeof labels !== 'object' || (labels as Record<string, unknown>)[this.operationLabel.split('=')[0]!] !== this.target.backupSetId ||
        path !== '/usr/bin/restic' || JSON.stringify(args) !== JSON.stringify(command) || state !== 'created') {
      throw new Error('RESTIC_READER_CONTAINER_IDENTITY_INVALID')
    }
    if (network !== 'none' || readOnly !== true || JSON.stringify(capDrop) !== JSON.stringify(['ALL']) ||
        JSON.stringify(capAdd) !== JSON.stringify(['CAP_DAC_READ_SEARCH']) ||
        JSON.stringify(security) !== JSON.stringify(['no-new-privileges:true']) ||
        JSON.stringify(tmpfs) !== JSON.stringify({ '/tmp': 'rw,noexec,nosuid,nodev,size=64m' })) {
      throw new Error('RESTIC_READER_CONTAINER_PROFILE_INVALID')
    }
    if (restart !== 'no' || autoRemove !== false || privileged !== false) throw new Error('RESTIC_READER_CONTAINER_LIFECYCLE_INVALID')
    if (pidMode !== '' || (ipcMode !== '' && ipcMode !== 'private')) throw new Error('RESTIC_READER_CONTAINER_NAMESPACE_INVALID')
    if (!emptyList(devices) || !emptyList(binds) || !emptyList(volumesFrom)) throw new Error('RESTIC_READER_CONTAINER_ATTACHMENTS_INVALID')
    if (!Array.isArray(mounts) || mounts.length !== 7) throw new Error('RESTIC_READER_MOUNTS_INVALID')
    const expected = new Map([
      ['/sources/state', ['volume', this.sourceVolumes.state, false]],
      ['/sources/caddy-data', ['volume', this.sourceVolumes.caddyData, false]],
      ['/sources/caddy-config', ['volume', this.sourceVolumes.caddyConfig, false]],
      ['/sources/staging', this.target.testStagingVolume
        ? ['volume', this.target.testStagingVolume, false] : ['bind', this.target.stagingDirectory, false]],
      ['/sources/deployment', this.target.testDeploymentVolume
        ? ['volume', this.target.testDeploymentVolume, false] : ['bind', this.target.deploymentRoot, false]],
      ['/repo', ['bind', this.target.repositoryDirectory, true]],
      ['/run/password', ['bind', this.target.passwordFile, false]],
    ])
    const destinations = new Set<string>()
    for (const mount of mounts as Array<{ Type?: unknown; Name?: unknown; Source?: unknown; Destination?: unknown; RW?: unknown }>) {
      const destination = mount.Destination
      const spec = typeof destination === 'string' ? expected.get(destination) : undefined
      if (!spec || destinations.has(destination as string)) throw new Error('RESTIC_READER_MOUNTS_INVALID')
      const [type, source, writable] = spec
      const item = mount
      if (item.Type !== type || (type === 'volume' ? item.Name !== source : !bindSourceMatches(item.Source, source as string)) ||
          item.RW !== writable || item.Destination === '/run/docker.sock') throw new Error('RESTIC_READER_MOUNTS_INVALID')
      destinations.add(destination as string)
    }
    if (destinations.size !== expected.size) throw new Error('RESTIC_READER_MOUNTS_INVALID')
  }

  private async ownedContainers(): Promise<string[]> {
    const ids = await this.docker(['ps', '-a', '--quiet', '--no-trunc', '--filter', `label=${this.operationLabel}`])
    const values = ids ? ids.split(/\s+/) : []
    if (values.length > 1 || values.some(id => !/^[a-f0-9]{64}$/.test(id))) throw new UnsafeMaintenanceRecoveryError('RESTIC_READER_CLEANUP_UNVERIFIED')
    return values
  }

  private async cleanupContainer(id: string): Promise<void> {
    const raw = oneObject(await this.docker(['inspect', '--type', 'container', id])) as ReaderInspect
    const labels = raw.Config?.Labels
    const expectedId = id
    if (raw.Id !== expectedId || labels?.[this.operationLabel.split('=')[0]!] !== this.target.backupSetId ||
        (raw.State?.Status !== 'exited' && raw.State?.Status !== 'created')) throw new UnsafeMaintenanceRecoveryError('RESTIC_READER_CLEANUP_UNVERIFIED')
    await this.docker(['rm', id])
    if ((await this.ownedContainers()).length !== 0) throw new UnsafeMaintenanceRecoveryError('RESTIC_READER_CLEANUP_UNVERIFIED')
  }

  async backup(): Promise<{ snapshotId: string }> {
    const target = this.target
    const stage = '/sources/staging/payload'
    const sources = ['/sources/state', '/sources/caddy-data', '/sources/caddy-config', '/sources/deployment', stage]
    if (sources.some(source => source === '/repo' || source.startsWith('/repo/') || source === '/run/password' || source.startsWith('/run/password/'))) {
      throw new Error('RESTIC_READER_SOURCE_INVALID')
    }
    const command = ['--repo', '/repo', '--password-file', '/run/password', '--no-cache', 'backup', '--json', '--quiet',
      '--tag', `aikayun-set-${target.backupSetId}`, '--tag', 'aikayun-role-source', '--', ...sources]
    const args = ['create', '--pull=never', '--name', this.containerName, '--label', this.operationLabel,
      '--network', 'none', '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m', '--cap-drop', 'ALL',
      '--cap-add', 'DAC_READ_SEARCH', '--security-opt', 'no-new-privileges:true', '--user', '0:0',
      ...this.mounts().flatMap(mount => ['--mount', mount]), '--entrypoint', '/usr/bin/restic', target.image, ...command]
    await target.assertLock()
    let createdId: string | undefined
    let result: { snapshotId: string } | undefined
    let failure: unknown
    try {
      const output = await this.docker(args, false)
      createdId = output.trim()
      if (!/^[a-f0-9]{64}$/.test(createdId)) throw new UnsafeMaintenanceRecoveryError('RESTIC_READER_CREATE_UNCERTAIN')
      this.created = true
      await this.verifyCreated(createdId, command)
      const snapshotId = await this.startAndReadSummary(createdId)
      const inspected = oneObject(await this.docker(['inspect', '--type', 'container', createdId])) as ReaderInspect
      if (inspected.Id !== createdId || inspected.Image !== this.imageId || inspected.State?.Status !== 'exited' ||
          inspected.State.ExitCode !== 0 || inspected.State.OOMKilled !== false) throw new UnsafeMaintenanceRecoveryError('RESTIC_READER_RESULT_UNCERTAIN')
      await this.cleanupContainer(createdId)
      result = { snapshotId }
    } catch (error) { failure = error }
    if (failure) {
      const ids = await this.ownedContainers().catch(() => { throw new UnsafeMaintenanceRecoveryError('RESTIC_READER_CLEANUP_UNVERIFIED') })
      for (const id of ids) {
        const raw = oneObject(await this.docker(['inspect', '--type', 'container', id])) as ReaderInspect
        if (raw.State?.Status === 'running' || raw.State?.Status === 'paused' || raw.State?.Status === 'restarting') {
          throw new UnsafeMaintenanceRecoveryError('RESTIC_READER_RESULT_UNCERTAIN')
        }
        await this.cleanupContainer(id)
      }
      if (failure instanceof UnsafeMaintenanceRecoveryError) throw failure
      if (failure instanceof Error && /^RESTIC_READER_[A-Z_]+$/.test(failure.message)) throw failure
      throw new Error(this.created ? 'RESTIC_READER_FAILED' : 'RESTIC_READER_CREATE_FAILED')
    }
    if (!result) throw new UnsafeMaintenanceRecoveryError('RESTIC_READER_RESULT_UNCERTAIN')
    await target.assertLock()
    return result
  }
}
