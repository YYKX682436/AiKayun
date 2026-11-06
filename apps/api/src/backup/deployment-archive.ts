import { trustedAncestors } from './restic-local.js'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath, unlink } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { UnsafeMaintenanceRecoveryError } from './maintenance-errors.js'

export interface DeploymentArchiveTarget {
  deploymentRoot: string
  stagingDirectory: string
  tarBinary: string
  /** Proves the existing installer-owned signature/identity checks and writer fence. */
  assertTrustedDeployment: () => Promise<void>
  /** Proves this 0700 directory uses memory or encrypted storage. */
  assertSecureStaging: () => Promise<void>
  signal?: AbortSignal | undefined
  timeoutMs?: number
}

const roots = ['.env', 'install-state.json', '.install-owner', 'aikayun', 'secrets', 'release'] as const
const secrets = ['api_database_password', 'code_pool_encryption_key_ring', 'migrator_database_password',
  'payment_credential_key_ring', 'postgres_admin_password']
const controls = ['release-manifest.json', 'release-manifest.jws', 'release-manifest.cosign.bundle']
const required = ['compose.yaml', 'install.sh', 'migration-checksums.json', 'license-trust-bundle.jws',
  'release-index.json', 'release-signing-root.jwk.json', 'release-verifier.mjs', 'verify-artifacts.mjs']

type Entry = { path: string; kind: 'dir' | 'file'; size: number; mode: number; uid: number; gid: number; sha256?: string }
function nested(parent: string, child: string) {
  const path = relative(parent, child)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

async function inspectFile(path: string, name: string): Promise<Entry> {
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || !Number.isSafeInteger(before.size)) throw new Error('DEPLOYMENT_PATH_UNSAFE')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const opened = await file.stat()
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1 || opened.size !== before.size) throw new Error('DEPLOYMENT_PATH_CHANGED')
    const hash = createHash('sha256')
    for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk)
    const after = await file.stat()
    if (opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs || opened.mode !== after.mode) throw new Error('DEPLOYMENT_PATH_CHANGED')
    return { path: name, kind: 'file', size: opened.size, mode: opened.mode & 0o777, uid: opened.uid, gid: opened.gid, sha256: hash.digest('hex') }
  } finally { await file.close() }
}

async function collect(root: string): Promise<Entry[]> {
  const entries: Entry[] = []
  async function walk(path: string, name: string): Promise<void> {
    if (entries.length >= 8192) throw new Error('DEPLOYMENT_ENTRY_LIMIT')
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw new Error('DEPLOYMENT_PATH_UNSAFE')
    if (info.isDirectory()) {
      if ((info.mode & 0o022) !== 0) throw new Error('DEPLOYMENT_DIRECTORY_UNSAFE')
      entries.push({ path: name, kind: 'dir', size: 0, mode: info.mode & 0o777, uid: info.uid, gid: info.gid })
      const children = (await readdir(path)).sort()
      for (const child of children) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(child) || child.includes('..')) throw new Error('DEPLOYMENT_PATH_UNSAFE')
        await walk(join(path, child), `${name}/${child}`)
      }
    } else entries.push(await inspectFile(path, name))
  }
  for (const name of roots) await walk(join(root, name), name)
  return entries
}

async function validateInventory(root: string, entries: Entry[], fixture: boolean) {
  const byName = new Map(entries.map(entry => [entry.path, entry]))
  for (const name of ['.env', 'install-state.json', '.install-owner', 'aikayun']) if (byName.get(name)?.kind !== 'file') throw new Error('DEPLOYMENT_INCOMPLETE')
  for (const name of ['.env', 'install-state.json', '.install-owner']) {
    const entry = byName.get(name)!
    if (entry.mode !== 0o600 || entry.uid !== process.getuid?.() || entry.gid !== process.getgid?.() || entry.size === 0) throw new Error('DEPLOYMENT_PATH_UNSAFE')
  }
  if (byName.get('aikayun')?.uid !== process.getuid?.() || byName.get('aikayun')?.gid !== process.getgid?.() || byName.get('aikayun')?.mode !== 0o755 ||
      byName.get('aikayun')?.sha256 !== byName.get('release/install.sh')?.sha256) throw new Error('DEPLOYMENT_INSTALLER_MISMATCH')
  if (byName.get('secrets')?.kind !== 'dir' || byName.get('release')?.kind !== 'dir') throw new Error('DEPLOYMENT_INCOMPLETE')
  if (byName.get('secrets')?.mode !== 0o700 || byName.get('secrets')?.uid !== process.getuid?.() || byName.get('secrets')?.gid !== process.getgid?.()) throw new Error('DEPLOYMENT_SECRETS_INVALID')
  const actualSecrets = entries.filter(entry => entry.path.startsWith('secrets/'))
  if (actualSecrets.length !== secrets.length || actualSecrets.some(entry => {
    const name = entry.path.slice('secrets/'.length)
    const uid = name === 'postgres_admin_password' ? 0 : 1000
    return entry.kind !== 'file' || !secrets.includes(name) || entry.size === 0 ||
      (fixture ? entry.uid !== process.getuid?.() || ![0o400, 0o600].includes(entry.mode)
        : entry.uid !== uid || entry.gid !== uid || entry.mode !== 0o400)
  })) throw new Error('DEPLOYMENT_SECRETS_INVALID')
  if (!/^aikayun-install-v1\n?$/.test((await openReadBounded(join(root, '.install-owner'), 128)).toString('utf8'))) throw new Error('DEPLOYMENT_OWNER_INVALID')
  let state: unknown, manifest: unknown
  try {
    state = JSON.parse((await openReadBounded(join(root, 'install-state.json'), 65536)).toString('utf8')) as unknown
    manifest = JSON.parse((await openReadBounded(join(root, 'release', 'release-manifest.json'), 16 * 1024 * 1024)).toString('utf8')) as unknown
  } catch { throw new Error('DEPLOYMENT_MANIFEST_INVALID') }
  if (!state || typeof state !== 'object' || Array.isArray(state) || !manifest || typeof manifest !== 'object' || Array.isArray(manifest) ||
      !('manifest_sha256' in state) || state.manifest_sha256 !== byName.get('release/release-manifest.json')?.sha256 ||
      !('artifacts' in manifest) || !Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0 || manifest.artifacts.length > 4096) {
    throw new Error('DEPLOYMENT_MANIFEST_INVALID')
  }
  const artifacts = new Map<string, { size: number; sha256: string }>()
  for (const value of manifest.artifacts) {
    if (!value || typeof value !== 'object' || typeof value.name !== 'string' || value.name.length > 128 ||
        !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value.name) || value.name.includes('..') ||
        value.name.split('/').some((part: string) => !part) || controls.includes(value.name) || artifacts.has(value.name) ||
        !Number.isSafeInteger(value.size) || value.size < 0 || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) {
      throw new Error('DEPLOYMENT_MANIFEST_INVALID')
    }
    artifacts.set(value.name, { size: value.size, sha256: value.sha256 })
  }
  for (const name of required) if (!artifacts.has(name)) throw new Error('DEPLOYMENT_INCOMPLETE')
  for (const name of controls) if (byName.get(`release/${name}`)?.kind !== 'file') throw new Error('DEPLOYMENT_INCOMPLETE')
  const files = entries.filter(entry => entry.kind === 'file' && entry.path.startsWith('release/'))
  if (files.length !== artifacts.size + controls.length) throw new Error('DEPLOYMENT_MANIFEST_MISMATCH')
  for (const entry of files) {
    const name = entry.path.slice('release/'.length)
    if (controls.includes(name)) continue
    const artifact = artifacts.get(name)
    if (!artifact || artifact.size !== entry.size || artifact.sha256 !== entry.sha256) throw new Error('DEPLOYMENT_MANIFEST_MISMATCH')
  }
}

async function openReadBounded(path: string, limit: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) throw new Error('DEPLOYMENT_PATH_UNSAFE')
    const bytes = Buffer.alloc(stat.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const chunk = await file.read(bytes, offset, bytes.length - offset, offset)
      if (!chunk.bytesRead) break
      offset += chunk.bytesRead
    }
    const after = await file.stat()
    if (offset !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error('DEPLOYMENT_PATH_CHANGED')
    return bytes.subarray(0, offset)
  } finally { await file.close() }
}

/** Caller must hold the deployment lock and quiesce all writers for the entire
 * call. The release signature and trusted directory ownership are verified by
 * the provided installer-owned callback, before and after collection. */
async function capture(input: DeploymentArchiveTarget, fixture: boolean, fixtureMetadata = false): Promise<{ size: number; sha256: string }> {
  if (!fixture && (process.platform !== 'linux' || process.getuid?.() !== 0)) throw new Error('DEPLOYMENT_ARCHIVE_PRIVILEGE_INVALID')
  for (const path of [input.deploymentRoot, input.stagingDirectory, input.tarBinary]) {
    if (!isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path) throw new Error('DEPLOYMENT_ARCHIVE_PATH_INVALID')
  }
  const [root, staging, tar] = await Promise.all([lstat(input.deploymentRoot), lstat(input.stagingDirectory), lstat(input.tarBinary)])
  if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o077) !== 0 || root.uid !== process.getuid?.() || root.gid !== process.getgid?.() ||
      !staging.isDirectory() || staging.isSymbolicLink() || (staging.mode & 0o777) !== 0o700 || staging.uid !== process.getuid?.() ||
      !tar.isFile() || tar.isSymbolicLink() || tar.nlink !== 1 || (tar.mode & 0o022) !== 0 || (tar.mode & 0o111) === 0 ||
      (tar.uid !== 0 && tar.uid !== process.getuid?.()) || nested(input.deploymentRoot, input.stagingDirectory) || nested(input.stagingDirectory, input.deploymentRoot)) {
    throw new Error('DEPLOYMENT_ARCHIVE_PATH_INVALID')
  }
  await trustedAncestors(input.tarBinary)
  if (input.signal?.aborted || (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 24 * 60 * 60 * 1000))) throw new Error('DEPLOYMENT_ARCHIVE_INVALID')
  await input.assertSecureStaging()
  await input.assertTrustedDeployment()
  const before = await collect(input.deploymentRoot)
  await validateInventory(input.deploymentRoot, before, fixture)
  const path = join(input.stagingDirectory, 'deployment.tar')
  const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
  let owned: Awaited<ReturnType<typeof file.stat>> | undefined
  let result: { size: number; sha256: string } | undefined
  let failure: unknown
  try {
    owned = await file.stat()
    const child = spawn(input.tarBinary, [...fixtureMetadata ? ['--format=posix', '--acls', '--xattrs', '--xattrs-include=*', '--sparse', '--sparse-version=0.1'] : [],
      '-cf', '-', '-C', input.deploymentRoot, ...roots], {
      env: { PATH: '/usr/bin:/bin', LANG: 'C' }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stderr!.resume()
    let interrupted = false
    const stop = () => { interrupted = true; child.kill('SIGKILL') }
    const timer = setTimeout(stop, input.timeoutMs ?? 30 * 60 * 1000)
    input.signal?.addEventListener('abort', stop, { once: true })
    if (input.signal?.aborted) stop()
    const exit = new Promise<boolean>(done => { child.once('error', () => done(false)); child.once('close', code => done(code === 0)) })
    const hash = createHash('sha256')
    let size = 0
    const dest = new Writable({ write(chunk: Buffer, _encoding, callback) {
      void (async () => {
        let offset = 0
        while (offset < chunk.length) {
          const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset, size + offset)
          if (!bytesWritten) throw new Error('DEPLOYMENT_ARCHIVE_WRITE_FAILED')
          offset += bytesWritten
        }
        size += chunk.length; hash.update(chunk)
      })().then(() => callback(), error => callback(error))
    } })
    try {
      const [streamed, exited] = await Promise.all([pipeline(child.stdout!, dest).then(() => true, () => { child.kill('SIGKILL'); return false }), exit])
      if (interrupted || !streamed || !exited) throw new Error('DEPLOYMENT_ARCHIVE_FAILED')
    } finally { clearTimeout(timer); input.signal?.removeEventListener('abort', stop) }
    await file.sync()
    const stat = await file.stat()
    if (!Number.isSafeInteger(size) || size < 1024 || stat.size !== size || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) throw new Error('DEPLOYMENT_ARCHIVE_INVALID')
    const after = await collect(input.deploymentRoot)
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('DEPLOYMENT_PATH_CHANGED')
    await validateInventory(input.deploymentRoot, after, fixture)
    await input.assertTrustedDeployment()
    result = { size, sha256: hash.digest('hex') }
  } catch (error) {
    failure = error
  }
  try { await file.close() } catch { throw new UnsafeMaintenanceRecoveryError('ARCHIVE_CLEANUP_UNVERIFIED') }
  if (!result) {
    try {
      if (input.signal?.aborted) throw new Error('interrupted')
      await input.assertSecureStaging()
      await input.assertTrustedDeployment()
      const current = await lstat(path)
      if (!owned || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.uid !== process.getuid?.() ||
          current.dev !== owned.dev || current.ino !== owned.ino) throw new Error('changed')
      await unlink(path)
    } catch { throw new UnsafeMaintenanceRecoveryError('ARCHIVE_CLEANUP_UNVERIFIED') }
    throw failure
  }
  return result
}

/** Fixed production ownership: bootstrap secret root:root 0400 and all
 * application secrets 1000:1000 0400, as established by the installer. */
export async function captureDeploymentArchive(input: DeploymentArchiveTarget): Promise<{ size: number; sha256: string }> {
  void input
  throw new Error('ARCHIVE_HELPER_AUTHENTICATION_UNAVAILABLE')
}

/** Synthetic local fixtures only; never relax ownership in production. */
export async function captureFixtureDeploymentArchive(input: DeploymentArchiveTarget, fixture: string): Promise<{ size: number; sha256: string }> {
  if (process.env.NODE_ENV !== 'test' || !/^aikayun-75a-test-[a-f0-9]{24}$/.test(fixture)) throw new Error('DEPLOYMENT_FIXTURE_INVALID')
  return capture(input, true)
}

/** Exercises production ownership checks and optional GNU tar metadata only on
 * an isolated synthetic tree, never as release authentication evidence. */
export async function captureFixtureProductionOwnedDeploymentArchive(input: DeploymentArchiveTarget, fixture: string, metadata = false): Promise<{ size: number; sha256: string }> {
  if (process.env.NODE_ENV !== 'test' || process.platform !== 'linux' || process.getuid?.() !== 0 ||
      !/^aikayun-75a-test-[a-f0-9]{24}$/.test(fixture) || (metadata && input.tarBinary !== '/usr/bin/tar')) throw new Error('DEPLOYMENT_FIXTURE_INVALID')
  return capture(input, false, metadata)
}
