import { isBackupPostgresImage } from './postgres-image.js'
import { trustedAncestors } from './restic-local.js'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath, unlink } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { UnsafeMaintenanceRecoveryError } from './maintenance-errors.js'

type VolumeKind = 'state' | 'caddy-data' | 'caddy-config'
export interface VolumeArchiveTarget {
  dockerBinary: string
  dockerSocket: string
  /** Digest reference from an authenticated release manifest. */
  postgresImage: string
  stagingDirectory: string
  /** Must prove private staging is on memory or encrypted storage. */
  assertSecureStaging: () => Promise<void>
  signal?: AbortSignal | undefined
  timeoutMs?: number
}

const fixed = {
  state: { name: 'aikayun_state', label: 'com.aikayun.managed-by', value: 'aikayun-7-3', file: 'state.tar' },
  'caddy-data': { name: 'aikayun_caddy_data', label: 'com.docker.compose.volume', value: 'caddy_data', file: 'caddy-data.tar' },
  'caddy-config': { name: 'aikayun_caddy_config', label: 'com.docker.compose.volume', value: 'caddy_config', file: 'caddy-config.tar' },
} as const
type VolumeSpec = { name: string; label: string; value: string; file: string; project?: string }

async function validate(input: VolumeArchiveTarget) {
  for (const path of [input.dockerBinary, input.dockerSocket, input.stagingDirectory]) {
    if (!isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path) throw new Error('ARCHIVE_PATH_INVALID')
  }
  const [binary, socket, root] = await Promise.all([lstat(input.dockerBinary), lstat(input.dockerSocket), lstat(input.stagingDirectory)])
  if (!binary.isFile() || binary.isSymbolicLink() || binary.nlink !== 1 || (binary.mode & 0o022) !== 0 ||
      (binary.mode & 0o111) === 0 || (binary.uid !== 0 && binary.uid !== process.getuid?.()) ||
      !socket.isSocket() || socket.isSymbolicLink() || (socket.uid !== 0 && socket.uid !== process.getuid?.()) || !root.isDirectory() || root.isSymbolicLink() ||
      (root.mode & 0o777) !== 0o700 || root.uid !== process.getuid?.()) throw new Error('ARCHIVE_PATH_INVALID')
  await trustedAncestors(input.dockerBinary)
  await trustedAncestors(input.dockerSocket)
  if (!isBackupPostgresImage(input.postgresImage)) throw new Error('ARCHIVE_IMAGE_INVALID')
  if (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 24 * 60 * 60 * 1000)) throw new Error('ARCHIVE_TIMEOUT_INVALID')
  if (input.signal?.aborted) throw new Error('ARCHIVE_INTERRUPTED')
  await input.assertSecureStaging()
}

/** All diagnostic command output is bounded and never logged. */
async function command(input: VolumeArchiveTarget, args: string[], output?: Writable): Promise<string> {
  const child = spawn(input.dockerBinary, ['--host', `unix://${input.dockerSocket}`, ...args], {
    env: { PATH: '/usr/bin:/bin', HOME: '/var/empty', LANG: 'C' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let text = ''
  let interrupted = false
  const stop = () => { interrupted = true; child.kill('SIGKILL') }
  const timer = setTimeout(stop, input.timeoutMs ?? 30 * 60 * 1000)
  input.signal?.addEventListener('abort', stop, { once: true })
  if (input.signal?.aborted) stop()
  child.stderr!.resume()
  const exit = new Promise<boolean>(done => { child.once('error', () => done(false)); child.once('close', code => done(code === 0)) })
  const sink = output ?? new Writable({ write(chunk: Buffer, _encoding, callback) {
    if (text.length + chunk.length > 1024 * 1024) { callback(new Error('ARCHIVE_OUTPUT_LIMIT')); return }
    text += chunk.toString('utf8'); callback()
  } })
  try {
    const [streamed, success] = await Promise.all([pipeline(child.stdout!, sink).then(() => true, () => { child.kill('SIGKILL'); return false }), exit])
    if (interrupted || input.signal?.aborted) throw new Error('ARCHIVE_INTERRUPTED')
    if (!streamed || !success) throw new Error('ARCHIVE_COMMAND_FAILED')
    return text
  } finally { clearTimeout(timer); input.signal?.removeEventListener('abort', stop) }
}

function parseOne(raw: string): Record<string, unknown> {
  let value: unknown
  try { value = JSON.parse(raw) as unknown } catch { throw new Error('ARCHIVE_INSPECTION_INVALID') }
  if (!Array.isArray(value) || value.length !== 1 || !value[0] || typeof value[0] !== 'object' || Array.isArray(value[0])) throw new Error('ARCHIVE_INSPECTION_INVALID')
  return value[0] as Record<string, unknown>
}

async function capture(input: VolumeArchiveTarget, spec: VolumeSpec, fixtureHelperId?: string) {
  await validate(input)
  const inspected = parseOne(await command(input, ['volume', 'inspect', spec.name]))
  const labels = inspected.Labels as Record<string, unknown> | undefined
  const options = inspected.Options
  if (inspected.Name !== spec.name || inspected.Driver !== 'local' || inspected.Scope !== 'local' ||
      (options !== null && options !== undefined && (typeof options !== 'object' || Object.keys(options).length !== 0)) ||
      !labels || labels[spec.label] !== spec.value ||
      (spec.project && labels['com.docker.compose.project'] !== spec.project)) throw new Error('ARCHIVE_VOLUME_IDENTITY_INVALID')
  const imageRef = fixtureHelperId ?? input.postgresImage
  const image = parseOne(await command(input, ['image', 'inspect', imageRef]))
  const config = image.Config as { Volumes?: Record<string, unknown> | null } | undefined
  if (fixtureHelperId ? image.Id !== fixtureHelperId || Object.keys(config?.Volumes ?? {}).length !== 0 :
    Object.keys(config?.Volumes ?? {}).some(path => path !== '/var/lib/postgresql')) throw new Error('ARCHIVE_IMAGE_VOLUME_UNEXPECTED')
  const outputPath = join(input.stagingDirectory, spec.file)
  const file = await open(outputPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
  const name = `aikayun-backup-archive-${randomUUID()}`
  let creationAttempted = false
  let creationConfirmed = false
  let outputComplete = false
  let result: { size: number; sha256: string } | undefined
  let operationError: unknown
  let cleanupError: Error | undefined
  try {
    creationAttempted = true
    const id = (await command(input, ['create', '--pull=never', '--name', name, '--label', `com.aikayun.backup.archive=${name}`, '--network', 'none',
      '--read-only', '--cap-drop', 'ALL', '--cap-add', 'DAC_READ_SEARCH', '--security-opt', 'no-new-privileges', '--user', '0:0',
      ...fixtureHelperId ? [] : ['--tmpfs', '/var/lib/postgresql:ro,noexec,nosuid'], '--mount', `type=volume,source=${spec.name},target=/snapshot,readonly`,
      '--entrypoint', fixtureHelperId ? '/usr/bin/tar' : 'tar', imageRef,
      ...fixtureHelperId ? ['--format=posix', '--acls', '--xattrs', '--xattrs-include=*', '--sparse', '--sparse-version=0.1'] : [],
      '-cf', '-', '-C', '/snapshot', '.'])).trim()
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('ARCHIVE_CONTAINER_INVALID')
    creationConfirmed = true
    const container = parseOne(await command(input, ['inspect', id]))
    const mounts = container.Mounts as Array<{ Type?: unknown; Name?: unknown; Destination?: unknown; RW?: unknown }> | undefined
    const host = container.HostConfig as { ReadonlyRootfs?: unknown; NetworkMode?: unknown; Tmpfs?: Record<string, unknown>; CapAdd?: unknown; CapDrop?: unknown; SecurityOpt?: unknown } | undefined
    const c = container.Config as { Labels?: Record<string, unknown>; Image?: unknown; User?: unknown } | undefined
    if (container.Id !== id || c?.User !== '0:0' || c.Image !== imageRef || (fixtureHelperId && container.Image !== fixtureHelperId) || c.Labels?.['com.aikayun.backup.archive'] !== name ||
        host?.ReadonlyRootfs !== true || host.NetworkMode !== 'none' ||
        (fixtureHelperId ? Object.keys(host.Tmpfs ?? {}).length !== 0 : host.Tmpfs?.['/var/lib/postgresql'] !== 'ro,noexec,nosuid') ||
        !Array.isArray(host.CapAdd) || host.CapAdd.length !== 1 || host.CapAdd[0] !== 'CAP_DAC_READ_SEARCH' ||
        !Array.isArray(host.CapDrop) || host.CapDrop.length !== 1 || host.CapDrop[0] !== 'ALL' ||
        !Array.isArray(host.SecurityOpt) || host.SecurityOpt.length !== 1 || host.SecurityOpt[0] !== 'no-new-privileges' ||
        !Array.isArray(mounts) || mounts.length !== 1 || mounts[0]?.Type !== 'volume' || mounts[0].Name !== spec.name ||
        mounts[0].Destination !== '/snapshot' || mounts[0].RW !== false) throw new Error('ARCHIVE_CONTAINER_UNSAFE')
    const hash = createHash('sha256')
    let size = 0
    const destination = new Writable({ write(chunk: Buffer, _encoding, callback) {
      void (async () => {
        let offset = 0
        while (offset < chunk.length) {
          const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset, size + offset)
          if (!bytesWritten) throw new Error('ARCHIVE_WRITE_FAILED')
          offset += bytesWritten
        }
        size += chunk.length
        hash.update(chunk)
      })().then(() => callback(), error => callback(error))
    } })
    await command(input, ['start', '-a', id], destination)
    if (!Number.isSafeInteger(size) || size < 1024) throw new Error('ARCHIVE_OUTPUT_INVALID')
    await file.sync()
    const stat = await file.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== size || (stat.mode & 0o777) !== 0o600) throw new Error('ARCHIVE_OUTPUT_INVALID')
    outputComplete = true
    result = { size, sha256: hash.digest('hex') }
  } catch (error) {
    operationError = error
  } finally {
    try { await file.close() } catch { cleanupError = new UnsafeMaintenanceRecoveryError('ARCHIVE_CLEANUP_UNVERIFIED') }
    if (creationAttempted) {
      const cleanup = { ...input, signal: undefined, timeoutMs: 15000 }
      try {
        // The create response may be lost after the daemon commits. Only remove
        // an object carrying this operation's unpredictable ownership label.
        const matches = (await command(cleanup, ['ps', '-a', '--filter', `label=com.aikayun.backup.archive=${name}`, '--format', '{{.ID}}'])).trim()
        if (matches) {
          if (!/^[a-f0-9]{12,64}$/.test(matches)) cleanupError = new UnsafeMaintenanceRecoveryError('ARCHIVE_CONTAINER_CLEANUP_UNVERIFIED')
          else await command(cleanup, ['rm', '-f', matches])
        }
      } catch { cleanupError = new UnsafeMaintenanceRecoveryError('ARCHIVE_CONTAINER_CLEANUP_UNVERIFIED') }
    }
    if (creationAttempted && !creationConfirmed) cleanupError ??= new UnsafeMaintenanceRecoveryError('ARCHIVE_CREATE_UNCERTAIN')
    // Unknown container or writer cleanup must retain partial evidence.
    if (!outputComplete && !cleanupError) await unlink(outputPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') cleanupError = new UnsafeMaintenanceRecoveryError('ARCHIVE_CLEANUP_UNVERIFIED')
    })
  }
  if (cleanupError) throw cleanupError
  if (operationError) throw operationError
  if (!result) throw new Error('ARCHIVE_OUTPUT_INVALID')
  return result
}

/** Fixed production volume mapping; PostgreSQL data is deliberately excluded.
 * The signed helper's tar and its image identity are not authenticated by the
 * current release gate. The legacy PostgreSQL BusyBox tar loses ACL/xattrs, so
 * no production collection may proceed until that gate is implemented. */
export function assertProductionVolumeHelperAvailable(): void {
  throw new Error('ARCHIVE_HELPER_AUTHENTICATION_UNAVAILABLE')
}

export async function captureReleaseVolume(input: VolumeArchiveTarget, kind: VolumeKind): Promise<{ size: number; sha256: string }> {
  if (!Object.hasOwn(fixed, kind)) throw new Error('ARCHIVE_VOLUME_INVALID')
  const spec = fixed[kind]
  if (!spec) throw new Error('ARCHIVE_VOLUME_INVALID')
  void input
  assertProductionVolumeHelperAvailable()
  throw new Error('ARCHIVE_HELPER_AUTHENTICATION_UNAVAILABLE')
}

/** Test fixture only: exact random prefix and ownership label, never fixed volumes. */
export async function captureFixtureVolume(input: VolumeArchiveTarget, fixture: string, kind: VolumeKind) {
  if (process.env.NODE_ENV !== 'test' || !/^aikayun-75a-test-[a-f0-9]{24}$/.test(fixture) || !Object.hasOwn(fixed, kind)) throw new Error('ARCHIVE_FIXTURE_INVALID')
  const suffix = { state: 'aikayun_state', 'caddy-data': 'caddy_data', 'caddy-config': 'caddy_config' }[kind]
  if (!suffix) throw new Error('ARCHIVE_FIXTURE_INVALID')
  return capture(input, { name: `${fixture}_${suffix}`, label: 'com.aikayun.fixture', value: fixture, file: fixed[kind].file })
}

/** Isolated candidate only. This is not a release-signature verifier and must
 * never be wired into production: a local image ID is not signature evidence. */
export async function captureFixtureVolumeWithMetadata(input: VolumeArchiveTarget, fixture: string, kind: VolumeKind, helperImageId: string) {
  if (process.env.NODE_ENV !== 'test' || !/^aikayun-75a-test-[a-f0-9]{24}$/.test(fixture) || !Object.hasOwn(fixed, kind) ||
      !/^sha256:[a-f0-9]{64}$/.test(helperImageId)) throw new Error('ARCHIVE_FIXTURE_INVALID')
  const suffix = { state: 'aikayun_state', 'caddy-data': 'caddy_data', 'caddy-config': 'caddy_config' }[kind]
  if (!suffix) throw new Error('ARCHIVE_FIXTURE_INVALID')
  return capture(input, { name: `${fixture}_${suffix}`, label: 'com.aikayun.fixture', value: fixture, file: fixed[kind].file }, helperImageId)
}
