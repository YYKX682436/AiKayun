import { constants } from 'node:fs'
import { mkdir, lstat, open, readFile, readdir, realpath, rmdir, statfs, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const tmpfsMagic = 0x01021994n
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const allowed = new Set(['database.dump', 'state.tar', 'deployment.tar', 'caddy-data.tar', 'caddy-config.tar', 'manifest.json', '.stage-owner.json', 'payload', 'manifest'])
const payloadAllowed = new Set([...allowed].filter(name => name !== '.stage-owner.json' && name !== 'payload' && name !== 'manifest'))
const manifestAllowed = new Set(['manifest.json'])
export interface TmpfsStagingOptions {
  /** A dedicated, root-owned 0700 Linux tmpfs mount, created with noswap. */
  mountRoot: string
  backupSetId: string
  /** Must check the real deployment flock before every operation. */
  assertLock: () => Promise<void>
  /** Must prove no detached process can still write before cleanup. */
  assertSafeCleanup: () => Promise<void>
}

function unescapeMount(value: string) { return value.replace(/\\([0-7]{3})/g, (_, value: string) => String.fromCharCode(parseInt(value, 8))) }

/** Rejects ordinary disks, swap-capable tmpfs and ambiguous stacked mounts. */
export async function assertNoSwapTmpfs(root: string, minimumBytes = 1n): Promise<bigint> {
  if (process.platform !== 'linux' || process.getuid?.() !== 0 || !isAbsolute(root) || resolve(root) !== root || await realpath(root) !== root || minimumBytes < 0n) throw new Error('STAGING_MOUNT_UNSAFE')
  const target = await lstat(root, { bigint: true })
  if (!target.isDirectory() || target.isSymbolicLink() || target.uid !== 0n || (target.mode & 0o777n) !== 0o700n) throw new Error('STAGING_MOUNT_UNSAFE')
  let parent = dirname(root)
  while (true) {
    const info = await lstat(parent, { bigint: true })
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0n || ((info.mode & 0o022n) !== 0n && (info.mode & 0o1000n) === 0n)) throw new Error('STAGING_MOUNT_UNSAFE')
    const next = dirname(parent)
    if (next === parent) break
    parent = next
  }
  const fs = await statfs(root, { bigint: true })
  const matches = (await readFile('/proc/self/mountinfo', 'utf8')).split('\n').map(line => line.split(' ')).filter(fields => fields.length > 9 && unescapeMount(fields[4]!) === root)
  if (fs.type !== tmpfsMagic || matches.length !== 1) throw new Error('STAGING_MOUNT_UNSAFE')
  const fields = matches[0]!
  const separator = fields.indexOf('-')
  if (separator < 0 || fields[separator + 1] !== 'tmpfs' || !fields[separator + 3]?.split(',').includes('noswap')) throw new Error('STAGING_MOUNT_UNSAFE')
  const available = fs.bavail * fs.bsize
  if (available < minimumBytes) throw new Error('STAGING_SPACE_INSUFFICIENT')
  return available
}

function stagingPath(options: TmpfsStagingOptions) {
  if (!uuid.test(options.backupSetId)) throw new Error('STAGING_ID_INVALID')
  return join(options.mountRoot, `set-${options.backupSetId}`)
}

async function syncDirectory(path: string) {
  const fd = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await fd.sync() } finally { await fd.close() }
}

/** Creates a private set only after the noswap mount and the lock are verified. */
export async function createTmpfsStaging(options: TmpfsStagingOptions, minimumBytes: bigint): Promise<string> {
  if (minimumBytes < 1n) throw new Error('STAGING_SPACE_INSUFFICIENT')
  await options.assertLock()
  await assertNoSwapTmpfs(options.mountRoot, minimumBytes)
  const path = stagingPath(options)
  await mkdir(path, { mode: 0o700 })
  const marker = await open(join(path, '.stage-owner.json'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await marker.writeFile(JSON.stringify({ version: 1, backup_set_id: options.backupSetId })); await marker.sync() } finally { await marker.close() }
  await syncDirectory(path)
  await syncDirectory(options.mountRoot)
  await options.assertLock()
  return path
}

/** Keep the set marker outside source data; reserve a separate manifest-only directory. */
export async function createTmpfsPayload(options: TmpfsStagingOptions, minimumBytes: bigint): Promise<string> {
  const parent = await createTmpfsStaging(options, minimumBytes)
  await options.assertLock()
  const payload = join(parent, 'payload')
  const metadata = join(parent, 'manifest')
  await mkdir(payload, { mode: 0o700 })
  await mkdir(metadata, { mode: 0o700 })
  await syncDirectory(parent)
  await assertTmpfsPayload(options)
  return payload
}

async function assertMarker(path: string, backupSetId: string) {
  const marker = await open(join(path, '.stage-owner.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await marker.stat()
    if (!info.isFile() || info.uid !== 0 || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || info.size > 1024) throw new Error('STAGING_CONTENT_UNSAFE')
    const data: unknown = JSON.parse(await marker.readFile('utf8'))
    if (JSON.stringify(data) !== JSON.stringify({ version: 1, backup_set_id: backupSetId })) throw new Error('STAGING_CONTENT_UNSAFE')
  } finally { await marker.close() }
}

/** Verify an owned stage container, including one used as extraction scratch. */
export async function assertTmpfsStaging(options: TmpfsStagingOptions): Promise<void> {
  await options.assertLock()
  await assertNoSwapTmpfs(options.mountRoot, 0n)
  const path = stagingPath(options)
  const [root, parent] = await Promise.all([lstat(options.mountRoot, { bigint: true }), lstat(path, { bigint: true })])
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== 0n || parent.dev !== root.dev || (parent.mode & 0o777n) !== 0o700n || await realpath(path) !== path) throw new Error('STAGING_DIRECTORY_UNSAFE')
  await assertMarker(path, options.backupSetId)
  await options.assertLock()
}

/** Use as the capture/publish secure-storage callback for this exact payload. */
export async function assertTmpfsPayload(options: TmpfsStagingOptions): Promise<void> {
  await assertTmpfsStaging(options)
  const path = stagingPath(options)
  const payload = join(path, 'payload')
  const metadata = join(path, 'manifest')
  const [root, child, metadataInfo] = await Promise.all([lstat(options.mountRoot, { bigint: true }), lstat(payload, { bigint: true }), lstat(metadata, { bigint: true })])
  if (!child.isDirectory() || child.isSymbolicLink() || child.uid !== 0n || child.dev !== root.dev || (child.mode & 0o777n) !== 0o700n ||
      await realpath(payload) !== payload || !metadataInfo.isDirectory() || metadataInfo.isSymbolicLink() || metadataInfo.uid !== 0n ||
      metadataInfo.dev !== root.dev || (metadataInfo.mode & 0o777n) !== 0o700n || await realpath(metadata) !== metadata ||
      (await readdir(path)).sort().join(',') !== '.stage-owner.json,manifest,payload') throw new Error('STAGING_DIRECTORY_UNSAFE')
  const metadataNames = await readdir(metadata)
  if (metadataNames.some(name => !manifestAllowed.has(name))) throw new Error('STAGING_CONTENT_UNSAFE')
  for (const name of metadataNames) {
    const info = await lstat(join(metadata, name), { bigint: true })
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0n || info.dev !== root.dev || info.nlink !== 1n) throw new Error('STAGING_CONTENT_UNSAFE')
  }
  await options.assertLock()
}

/** Explicit recovery must first prove the original writers have stopped. It
 * refuses unknown files, links or mountpoints instead of recursively deleting. */
export async function removeTmpfsStaging(options: TmpfsStagingOptions): Promise<void> {
  await options.assertLock()
  await options.assertSafeCleanup()
  await assertNoSwapTmpfs(options.mountRoot, 0n)
  const path = stagingPath(options)
  const [root, directory] = await Promise.all([lstat(options.mountRoot, { bigint: true }), lstat(path, { bigint: true })])
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== 0n || directory.dev !== root.dev || (directory.mode & 0o777n) !== 0o700n || await realpath(path) !== path) throw new Error('STAGING_DIRECTORY_UNSAFE')
  const names = await readdir(path)
  if (names.some(name => !allowed.has(name))) throw new Error('STAGING_CONTENT_UNSAFE')
  if ((names.includes('payload') || names.includes('manifest')) && names.some(name => name !== 'payload' && name !== 'manifest' && name !== '.stage-owner.json')) {
    throw new Error('STAGING_CONTENT_UNSAFE')
  }
  let payloadNames: string[] = [], manifestNames: string[] = []
  for (const name of names) {
    const info = await lstat(join(path, name), { bigint: true })
    if (name === 'payload' || name === 'manifest') {
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0n || info.dev !== root.dev || (info.mode & 0o777n) !== 0o700n || await realpath(join(path, name)) !== join(path, name)) throw new Error('STAGING_CONTENT_UNSAFE')
      const children = await readdir(join(path, name))
      if (name === 'payload') payloadNames = children
      else manifestNames = children
      const permittedChildren = name === 'payload' ? payloadAllowed : manifestAllowed
      for (const child of children) {
        if (!permittedChildren.has(child)) throw new Error('STAGING_CONTENT_UNSAFE')
        const item = await lstat(join(path, name, child), { bigint: true })
        if (!item.isFile() || item.isSymbolicLink() || item.uid !== 0n || item.nlink !== 1n || item.dev !== root.dev) throw new Error('STAGING_CONTENT_UNSAFE')
      }
      continue
    }
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0n || info.nlink !== 1n || info.dev !== root.dev) throw new Error('STAGING_CONTENT_UNSAFE')
  }
  if (!names.includes('.stage-owner.json')) throw new Error('STAGING_CONTENT_UNSAFE')
  await assertMarker(path, options.backupSetId)
  await options.assertLock()
  await options.assertSafeCleanup()
  // Keep the ownership marker until the last step so an interrupted cleanup
  // can be retried after the remaining writers have been checked again.
  const beforeRemoval = async () => { await options.assertLock(); await options.assertSafeCleanup() }
  for (const child of manifestNames) { await beforeRemoval(); await unlink(join(path, 'manifest', child)) }
  if (names.includes('manifest')) { await beforeRemoval(); await rmdir(join(path, 'manifest')) }
  for (const child of payloadNames) { await beforeRemoval(); await unlink(join(path, 'payload', child)) }
  if (names.includes('payload')) { await beforeRemoval(); await rmdir(join(path, 'payload')) }
  for (const name of names.filter(name => name !== '.stage-owner.json' && name !== 'payload' && name !== 'manifest')) {
    await beforeRemoval(); await unlink(join(path, name))
  }
  if (names.includes('.stage-owner.json')) { await beforeRemoval(); await unlink(join(path, '.stage-owner.json')) }
  await beforeRemoval()
  await rmdir(path)
  await syncDirectory(options.mountRoot)
}
