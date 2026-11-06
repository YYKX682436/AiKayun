import { constants } from 'node:fs'
import { lstat, open, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { ReadonlyTrustBundleInspection } from '../licensing/trust/trust-bundle-store.js'
import { inspectArchivedTrustStore } from './state-archive-trust.js'
import type { StateArchiveTrustStoreFiles } from './state-archive-protection.js'
import { verifyStateIdentityFiles } from './state-identity-validation.js'
import { verifyDeploymentKeyRingBytes } from './deployment-keyring-pair.js'
import { isValidStateVolumeMarker, stateVolumeMarkerLength } from './state-volume-marker.js'
import type { readBackupDatabaseMetadata } from './database-metadata.js'
import type { readBackupKeyReferences } from './key-references.js'
import type { LocalResticRepository } from './restic-local.js'

type DatabaseMetadata = Awaited<ReturnType<typeof readBackupDatabaseMetadata>>
type KeyReferences = Awaited<ReturnType<typeof readBackupKeyReferences>>
type ResticNode = { struct_type?: unknown; name?: unknown; type?: unknown; path?: unknown; uid?: unknown; gid?: unknown; size?: unknown; mode?: unknown; inode?: unknown }
const protectedIdentityFiles = [
  '/sources/state/identity/current/identity.json',
  '/sources/state/identity/current/identity-intent.json',
  '/sources/state/identity/current/instance-private-key.pk8.pem',
  '/sources/state/license-pending/license-pending-aes-256-gcm.json',
] as const

function parseNodes(raw: string): ResticNode[] {
  const result: ResticNode[] = []
  for (const line of raw.trim().split('\n')) {
    if (!line) continue
    let item: unknown
    try { item = JSON.parse(line) as unknown } catch { throw new Error('BACKUP_SOURCE_LIST_INVALID') }
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('BACKUP_SOURCE_LIST_INVALID')
    if ('struct_type' in item && item.struct_type === 'node') result.push(item as ResticNode)
  }
  return result
}

function validNode(node: ResticNode, expectedPath: string, type: 'dir' | 'file', uid: number, gid: number, mode: number,
  allowEmptyFile = false): boolean {
  return node.path === expectedPath && node.type === type && node.uid === uid && node.gid === gid &&
    typeof node.mode === 'number' && Number.isSafeInteger(node.mode) && (node.mode & 0o7777) === mode &&
    (type === 'dir' || (Number.isSafeInteger(node.size) && (allowEmptyFile ? (node.size as number) >= 0 : (node.size as number) > 0) &&
      Number.isSafeInteger(node.inode)))
}

async function nodeAt(repo: LocalResticRepository, snapshot: string, path: string): Promise<ResticNode> {
  const nodes = parseNodes(await repo.listSnapshot(snapshot, path))
  const matches = nodes.filter(node => node.path === path)
  if (matches.length !== 1) throw new Error('BACKUP_SOURCE_NODE_INVALID')
  return matches[0]!
}

async function childrenAt(repo: LocalResticRepository, snapshot: string, directory: string): Promise<{ root: ResticNode; children: ResticNode[] }> {
  const nodes = parseNodes(await repo.listSnapshot(snapshot, directory))
  const roots = nodes.filter(node => node.path === directory)
  if (roots.length !== 1 || roots[0]!.type !== 'dir') throw new Error('BACKUP_SOURCE_NODE_INVALID')
  const prefix = `${directory}/`
  const children = nodes.filter(node => typeof node.path === 'string' && node.path.startsWith(prefix) && !node.path.slice(prefix.length).includes('/'))
  return { root: roots[0]!, children }
}

export async function readSnapshotFile(input: {
  repo: LocalResticRepository; snapshot: string; scratch: string; path: string; maxBytes: number
  owner: number; group: number; mode: number; assertLock(): Promise<void>
}): Promise<Buffer> {
  const node = await nodeAt(input.repo, input.snapshot, input.path)
  if (!validNode(node, input.path, 'file', input.owner, input.group, input.mode) ||
      typeof node.size !== 'number' || node.size > input.maxBytes) throw new Error('BACKUP_SOURCE_NODE_INVALID')
  const target = join(input.scratch, 'manifest.json')
  let file
  let identity: { dev: number; ino: number } | undefined
  let bytes: Buffer | undefined
  let failure: unknown
  try {
    await input.assertLock()
    file = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
    const before = await file.stat()
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.() || before.size !== 0 || (before.mode & 0o777) !== 0o600) {
      throw new Error('BACKUP_SOURCE_SCRATCH_INVALID')
    }
    identity = { dev: before.dev, ino: before.ino }
    await input.repo.dumpFile(input.snapshot, input.path, file, node.size)
    const written = await file.stat()
    if (written.dev !== before.dev || written.ino !== before.ino || written.nlink !== 1 || written.size !== node.size ||
        written.uid !== before.uid || written.mode !== before.mode) throw new Error('BACKUP_SOURCE_FILE_INVALID')
    bytes = Buffer.alloc(node.size)
    let offset = 0
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset)
      if (read.bytesRead === 0) throw new Error('BACKUP_SOURCE_FILE_INVALID')
      offset += read.bytesRead
    }
    const after = await file.stat()
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== node.size || after.nlink !== 1 ||
        after.uid !== before.uid || after.mode !== before.mode || after.mtimeMs < written.mtimeMs) throw new Error('BACKUP_SOURCE_FILE_INVALID')
    await input.assertLock()
  } catch (error) { failure = error }
  if (file) await file.close().catch(() => { failure = new Error('BACKUP_SOURCE_SCRATCH_CLEANUP_UNVERIFIED') })
  try {
    const current = await lstat(target)
    if (!identity || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.uid !== process.getuid?.() ||
        current.dev !== identity.dev || current.ino !== identity.ino) throw new Error('unsafe')
    await input.assertLock()
    await unlink(target)
  } catch { failure = new Error('BACKUP_SOURCE_SCRATCH_CLEANUP_UNVERIFIED') }
  if (failure) { bytes?.fill(0); throw failure }
  if (!bytes) throw new Error('BACKUP_SOURCE_FILE_INVALID')
  return bytes
}

async function verifyStateLayout(input: { repo: LocalResticRepository; snapshot: string; appUid: number; appGid: number }): Promise<Map<string, ResticNode>> {
  const { root: stateRoot, children: roots } = await childrenAt(input.repo, input.snapshot, '/sources/state')
  const required = new Map(roots.map(node => [String(node.name), node]))
  if (!required.has('.aikayun-volume-v1') || !required.has('identity') || !required.has('license-pending') ||
      !required.has('license-trust') || !required.has('media') || !required.has('private-files')) throw new Error('BACKUP_STATE_PROTECTION_INVALID')
  if (stateRoot.type !== 'dir') throw new Error('BACKUP_STATE_PROTECTION_INVALID')
  for (const name of ['media', 'private-files']) {
    const node = required.get(name)!
    if (!validNode(node, `/sources/state/${name}`, 'dir', input.appUid, input.appGid, 0o700)) throw new Error('BACKUP_STATE_PROTECTION_INVALID')
  }
  const identity = await childrenAt(input.repo, input.snapshot, '/sources/state/identity')
  if (!validNode(identity.root, '/sources/state/identity', 'dir', input.appUid, input.appGid, 0o700) ||
      identity.children.map(node => node.name).sort().join(',') !== 'current') throw new Error('BACKUP_STATE_PROTECTION_INVALID')
  const current = await childrenAt(input.repo, input.snapshot, '/sources/state/identity/current')
  if (!validNode(current.root, '/sources/state/identity/current', 'dir', input.appUid, input.appGid, 0o700) ||
      current.children.map(node => node.name).sort().join(',') !== 'identity-intent.json,identity.json,instance-private-key.pk8.pem') throw new Error('BACKUP_STATE_PROTECTION_INVALID')
  for (const path of protectedIdentityFiles.slice(0, 3)) {
    const node = current.children.find(item => item.path === path)
    if (!node || !validNode(node, path, 'file', input.appUid, input.appGid, 0o600)) throw new Error('BACKUP_STATE_PROTECTION_INVALID')
  }
  const pending = await childrenAt(input.repo, input.snapshot, '/sources/state/license-pending')
  if (!validNode(pending.root, '/sources/state/license-pending', 'dir', input.appUid, input.appGid, 0o700) ||
      pending.children.some(node => typeof node.name === 'string' && node.name.startsWith('.pending-key-') && node.name.endsWith('.tmp'))) {
    throw new Error('BACKUP_STATE_PROTECTION_INVALID')
  }
  const pendingFile = pending.children.find(node => node.path === protectedIdentityFiles[3])
  if (!pendingFile || !validNode(pendingFile, protectedIdentityFiles[3], 'file', input.appUid, input.appGid, 0o600)) {
    throw new Error('BACKUP_STATE_PROTECTION_INVALID')
  }
  const trust = await childrenAt(input.repo, input.snapshot, '/sources/state/license-trust')
  if (!validNode(trust.root, '/sources/state/license-trust', 'dir', input.appUid, input.appGid, 0o700) ||
      trust.children.some(node => !['trust-bundle-state.json', 'trust-bundle-store.marker.json', '.trust-bundle.kernel-lock'].includes(String(node.name)))) {
    throw new Error('BACKUP_STATE_PROTECTION_INVALID')
  }
  const trustFiles = new Map<string, ResticNode>()
  for (const node of trust.children) {
    if (node.name === '.trust-bundle.kernel-lock') {
      if (!validNode(node, String(node.path), 'file', input.appUid, input.appGid, 0o600, true) || (node.size as number) > 1024) {
        throw new Error('BACKUP_STATE_PROTECTION_INVALID')
      }
    } else {
      const max = node.name === 'trust-bundle-state.json' ? 32 * 1024 : 64 * 1024
      if (node.type !== 'file' || node.uid !== input.appUid || node.gid !== input.appGid ||
          typeof node.mode !== 'number' || ![0o400, 0o600].includes(node.mode & 0o7777) ||
          !Number.isSafeInteger(node.size) || (node.size as number) < 1 || (node.size as number) > max || !Number.isSafeInteger(node.inode)) {
        throw new Error('BACKUP_STATE_PROTECTION_INVALID')
      }
      trustFiles.set(String(node.name), node)
    }
  }
  if (trustFiles.has('trust-bundle-state.json') !== trustFiles.has('trust-bundle-store.marker.json')) throw new Error('BACKUP_STATE_PROTECTION_INVALID')
  const marker = required.get('.aikayun-volume-v1')!
  if (!validNode(marker, '/sources/state/.aikayun-volume-v1', 'file', 0, 0, 0o400) ||
      (marker.size !== stateVolumeMarkerLength && marker.size !== stateVolumeMarkerLength + 1)) {
    throw new Error('BACKUP_STATE_PROTECTION_INVALID')
  }
  // Compare inode identities across the complete state tree so a protected
  // file cannot be hardlinked elsewhere in a Restic source snapshot.
  const protectedInodes = new Map<number, string>()
  for (const path of protectedIdentityFiles) {
    const node = path === protectedIdentityFiles[3] ? pendingFile : current.children.find(item => item.path === path)
    if (!node || typeof node.inode !== 'number' || !Number.isSafeInteger(node.inode) || protectedInodes.has(node.inode)) {
      throw new Error('BACKUP_STATE_PROTECTION_INVALID')
    }
    protectedInodes.set(node.inode, path)
  }
  await input.repo.visitSnapshotNodes(input.snapshot, '/sources/state', node => {
    if (node.type !== 'file' || typeof node.inode !== 'number' || typeof node.path !== 'string') return
    const protectedPath = protectedInodes.get(node.inode)
    if (protectedPath && protectedPath !== node.path) throw new Error('BACKUP_STATE_PROTECTION_INVALID')
  })
  return trustFiles
}

export async function verifyDirectSourceSnapshot(input: {
  repo: LocalResticRepository
  set: string
  snapshot: string
  scratch: string
  databaseDump: { size: number; sha256: string }
  database: DatabaseMetadata
  keys: KeyReferences
  appUid: number
  appGid: number
  inspectTrustStoreReadOnly(directory: string): Promise<ReadonlyTrustBundleInspection>
  assertLock(): Promise<void>
  signal?: AbortSignal
}): Promise<{ identityFileSha256: string; trustBundle: ReadonlyTrustBundleInspection }> {
  await input.assertLock()
  let records: unknown
  try { records = await input.repo.snapshotMetadata(input.set) } catch { throw new Error('BACKUP_SOURCE_SNAPSHOT_INVALID') }
  if (!Array.isArray(records) || records.length > 4) throw new Error('BACKUP_SOURCE_SNAPSHOT_INVALID')
  const setTag = `aikayun-set-${input.set}`
  const sourceTag = 'aikayun-role-source'
  const matches = records.filter((item: unknown) => item && typeof item === 'object' && !Array.isArray(item) &&
    'tags' in item && Array.isArray(item.tags) && item.tags.includes(setTag) && item.tags.includes(sourceTag))
  if (matches.length !== 1 || !('id' in (matches[0] as object)) || (matches[0] as { id?: unknown }).id !== input.snapshot ||
      !('paths' in (matches[0] as object)) || !Array.isArray((matches[0] as { paths?: unknown }).paths) ||
      JSON.stringify([...(matches[0] as { paths: unknown[] }).paths].sort()) !== JSON.stringify([
        '/sources/caddy-config', '/sources/caddy-data', '/sources/deployment', '/sources/staging/payload', '/sources/state',
      ])) throw new Error('BACKUP_SOURCE_SNAPSHOT_INVALID')
  const source = matches[0] as { tags: string[] }
  if (source.tags.length !== 2 || !source.tags.includes(setTag) || !source.tags.includes(sourceTag)) throw new Error('BACKUP_SOURCE_SNAPSHOT_INVALID')
  if (input.signal?.aborted) throw new Error('BACKUP_SOURCE_INTERRUPTED')
  const dumpPath = '/sources/staging/payload/database.dump'
  const dumpNode = await nodeAt(input.repo, input.snapshot, dumpPath)
  const dumpUid = process.getuid?.(), dumpGid = process.getgid?.()
  if (dumpUid === undefined || dumpGid === undefined || !validNode(dumpNode, dumpPath, 'file', dumpUid, dumpGid, 0o600) ||
      dumpNode.size !== input.databaseDump.size) throw new Error('BACKUP_SOURCE_DUMP_MISMATCH')
  const storedDump = await input.repo.hashSnapshotFile(input.snapshot, dumpPath, input.databaseDump.size)
  if (storedDump.size !== input.databaseDump.size || storedDump.sha256 !== input.databaseDump.sha256) throw new Error('BACKUP_SOURCE_DUMP_MISMATCH')
  const trustNodes = await verifyStateLayout({ repo: input.repo, snapshot: input.snapshot, appUid: input.appUid, appGid: input.appGid })
  const owner = input.appUid, group = input.appGid
  let identity: Buffer | undefined, intent: Buffer | undefined, privateKey: Buffer | undefined, pendingKey: Buffer | undefined
  let identityFileSha256: string
  try {
    identity = await readSnapshotFile({ repo: input.repo, snapshot: input.snapshot, scratch: input.scratch,
      path: protectedIdentityFiles[0], maxBytes: 16384, owner, group, mode: 0o600, assertLock: input.assertLock })
    intent = await readSnapshotFile({ repo: input.repo, snapshot: input.snapshot, scratch: input.scratch,
      path: protectedIdentityFiles[1], maxBytes: 16384, owner, group, mode: 0o600, assertLock: input.assertLock })
    privateKey = await readSnapshotFile({ repo: input.repo, snapshot: input.snapshot, scratch: input.scratch,
      path: protectedIdentityFiles[2], maxBytes: 16384, owner, group, mode: 0o600, assertLock: input.assertLock })
    pendingKey = await readSnapshotFile({ repo: input.repo, snapshot: input.snapshot, scratch: input.scratch,
      path: protectedIdentityFiles[3], maxBytes: 4096, owner, group, mode: 0o600, assertLock: input.assertLock })
    identityFileSha256 = await verifyStateIdentityFiles({ identity, intent, privateKey, pendingKey, metadata: input.database })
  } finally { identity?.fill(0); intent?.fill(0); privateKey?.fill(0); pendingKey?.fill(0) }
  const marker = await readSnapshotFile({ repo: input.repo, snapshot: input.snapshot, scratch: input.scratch,
    path: '/sources/state/.aikayun-volume-v1', maxBytes: 64, owner: 0, group: 0, mode: 0o400, assertLock: input.assertLock })
  try { if (!isValidStateVolumeMarker(marker)) throw new Error('BACKUP_STATE_PROTECTION_INVALID') }
  finally { marker.fill(0) }
  const trustFiles: StateArchiveTrustStoreFiles = { state: null, checkpoint: null }
  const stateNode = trustNodes.get('trust-bundle-state.json'), checkpointNode = trustNodes.get('trust-bundle-store.marker.json')
  let trustBundle: ReadonlyTrustBundleInspection
  try {
    if (stateNode && checkpointNode) {
      trustFiles.state = await readSnapshotFile({ repo: input.repo, snapshot: input.snapshot, scratch: input.scratch,
        path: '/sources/state/license-trust/trust-bundle-state.json', maxBytes: 32 * 1024, owner, group,
        mode: (stateNode.mode as number) & 0o7777, assertLock: input.assertLock })
      trustFiles.checkpoint = await readSnapshotFile({ repo: input.repo, snapshot: input.snapshot, scratch: input.scratch,
        path: '/sources/state/license-trust/trust-bundle-store.marker.json', maxBytes: 64 * 1024, owner, group,
        mode: (checkpointNode.mode as number) & 0o7777, assertLock: input.assertLock })
    }
    trustBundle = await inspectArchivedTrustStore({ stagingDirectory: input.scratch, files: trustFiles,
      inspectReadOnly: input.inspectTrustStoreReadOnly })
  } finally { trustFiles.state?.fill(0); trustFiles.checkpoint?.fill(0) }
  const payPath = '/sources/deployment/secrets/payment_credential_key_ring'
  const deliveryPath = '/sources/deployment/secrets/code_pool_encryption_key_ring'
  const payNode = await nodeAt(input.repo, input.snapshot, payPath)
  const deliveryNode = await nodeAt(input.repo, input.snapshot, deliveryPath)
  if (!validNode(payNode, payPath, 'file', 1000, 1000, 0o400) || (payNode.size as number) > 65536 ||
      !validNode(deliveryNode, deliveryPath, 'file', 1000, 1000, 0o400) || (deliveryNode.size as number) > 65536) {
    throw new Error('BACKUP_DEPLOYMENT_KEYRING_MISMATCH')
  }
  let paymentBytes: Buffer | undefined, deliveryBytes: Buffer | undefined
  try {
    paymentBytes = await readSnapshotFile({ repo: input.repo, snapshot: input.snapshot, scratch: input.scratch,
      path: payPath, maxBytes: 65536, owner: 1000, group: 1000, mode: 0o400, assertLock: input.assertLock })
    deliveryBytes = await readSnapshotFile({ repo: input.repo, snapshot: input.snapshot, scratch: input.scratch,
      path: deliveryPath, maxBytes: 65536, owner: 1000, group: 1000, mode: 0o400, assertLock: input.assertLock })
    verifyDeploymentKeyRingBytes(paymentBytes, deliveryBytes, input.keys)
  } finally { paymentBytes?.fill(0); deliveryBytes?.fill(0) }
  await input.assertLock()
  return { identityFileSha256, trustBundle }
}
