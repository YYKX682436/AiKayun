import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyDirectSourceSnapshot } from '../src/backup/direct-source-inspection.js'
import { createBackupIdentityFixture } from './fixtures/backup-identity-fixture.js'

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex')
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

class FakeRestic {
  readonly snapshot = 'a'.repeat(64)
  readonly set = randomUUID()
  readonly nodes: Array<Record<string, unknown>> = []
  readonly files = new Map<string, Buffer>()
  hardlink?: { inode: number; path: string }
  databaseDump = Buffer.from('PGDMP-fixture-direct')

  async snapshotMetadata(set: string) {
    if (set !== this.set) return []
    return [{ id: this.snapshot, tags: [`aikayun-set-${this.set}`, 'aikayun-role-source'], paths: [
      '/sources/caddy-config', '/sources/caddy-data', '/sources/deployment', '/sources/staging/payload', '/sources/state',
    ] }]
  }
  async hashSnapshotFile(_snapshot: string, path: string, _limit: number) {
    const value = this.files.get(path)!
    return { size: value.length, sha256: sha(value) }
  }
  async dumpFile(_snapshot: string, path: string, destination: { write(bytes: Buffer): Promise<unknown> }) {
    const value = this.files.get(path)
    if (!value) throw new Error('RESTIC_DUMP_INVALID')
    await destination.write(value)
  }
  async listSnapshot(_snapshot: string, path?: string) {
    const selected = this.nodes.filter(node => {
      if (node.path === path) return true
      return node.path === path || (typeof node.path === 'string' && typeof path === 'string' &&
        node.path.startsWith(`${path}/`) && !node.path.slice(path.length + 1).includes('/'))
    })
    return [JSON.stringify({ struct_type: 'snapshot', message_type: 'snapshot' }),
      ...selected.map(node => JSON.stringify({ struct_type: 'node', message_type: 'node', ...node }))].join('\n')
  }
  async visitSnapshotNodes(_snapshot: string, path: string, visitor: (node: Record<string, unknown>) => void) {
    for (const node of this.nodes) if (typeof node.path === 'string' && (node.path === path || node.path.startsWith(`${path}/`))) {
      visitor({ struct_type: 'node', ...node })
    }
    if (this.hardlink) visitor({ struct_type: 'node', type: 'file', path: this.hardlink.path, inode: this.hardlink.inode,
      uid: process.getuid?.() ?? 501, gid: process.getgid?.() ?? 501, mode: 0o600, size: 1 })
  }
  add(path: string, name: string, type: 'dir' | 'file', uid: number, gid: number, mode: number, bytes?: Buffer, inode?: number) {
    const node = { struct_type: 'node', path, name, type, uid, gid, mode,
      ...(type === 'file' ? { size: bytes!.length, inode: inode ?? this.nodes.length + 1000 } : {}) }
    this.nodes.push(node)
    if (type === 'file') this.files.set(path, bytes!)
    return node
  }
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aikayun-75a-direct-source-')))
  roots.push(root)
  const scratch = join(root, 'scratch')
  await mkdir(scratch, { mode: 0o700 })
  const repo = new FakeRestic()
  const identity = await createBackupIdentityFixture()
  const appUid = process.getuid?.() ?? 501, appGid = process.getgid?.() ?? appUid
  const pending = randomBytes(32), pay = randomBytes(32), delivery = randomBytes(32)
  const pendingKeyId = `lp-${randomBytes(16).toString('hex')}`
  const database = { databaseId: identity.identity.database_id, instanceId: identity.identity.instance_id,
    identityJkt: identity.identity.identity_jkt, pendingKeyId, pendingKeySha256: sha(pending),
    migrationHead: 'fixture_migration', migrationChecksumsSha256: 'b'.repeat(64) }
  const keys = { paymentKeyIds: ['pay'], deliveryKeyIds: ['delivery'], paymentReferencedKeyIds: [], deliveryReferencedKeyIds: [],
    paymentActiveKeyId: 'pay', deliveryActiveKeyId: 'delivery', paymentKeyDigests: { pay: sha(pay) },
    deliveryKeyDigests: { delivery: sha(delivery) }, contentVerification: 'not_verified' as const }
  const addDir = (p: string, n: string, uid = appUid, gid = appGid, mode = 0o700) => repo.add(p, n, 'dir', uid, gid, mode)
  const addFile = (p: string, n: string, bytes: Buffer, uid = appUid, gid = appGid, mode = 0o600, inode?: number) =>
    repo.add(p, n, 'file', uid, gid, mode, bytes, inode)
  addDir('/sources/caddy-data', 'caddy-data', 1000, 1000, 0o700)
  addDir('/sources/caddy-config', 'caddy-config', 1000, 1000, 0o700)
  addDir('/sources/state', 'state', 0, 0, 0o755)
  addFile('/sources/state/.aikayun-volume-v1', '.aikayun-volume-v1', Buffer.from('aikayun-state-volume-v1\n'), 0, 0, 0o400)
  for (const name of ['identity', 'license-pending', 'license-trust', 'media', 'private-files']) addDir(`/sources/state/${name}`, name)
  addFile('/sources/state/license-trust/.trust-bundle.kernel-lock', '.trust-bundle.kernel-lock', Buffer.alloc(0))
  addDir('/sources/state/identity/current', 'current')
  addFile('/sources/state/identity/current/identity.json', 'identity.json', identity.identityBytes)
  addFile('/sources/state/identity/current/identity-intent.json', 'identity-intent.json', identity.intentBytes)
  addFile('/sources/state/identity/current/instance-private-key.pk8.pem', 'instance-private-key.pk8.pem', identity.privateBytes)
  addFile('/sources/state/license-pending/license-pending-aes-256-gcm.json', 'license-pending-aes-256-gcm.json', Buffer.from(JSON.stringify({
    schema: 1, purpose: 'aikayun-license-pending-aes-256-gcm-v1', key_id: pendingKeyId, key: pending.toString('base64url'),
  })))
  addDir('/sources/deployment', 'deployment', 0, 0)
  addDir('/sources/deployment/secrets', 'secrets', 0, 0, 0o700)
  addFile('/sources/deployment/secrets/payment_credential_key_ring', 'payment_credential_key_ring',
    Buffer.from(JSON.stringify({ activeKeyId: 'pay', keys: { pay: pay.toString('base64') } })), 1000, 1000, 0o400)
  addFile('/sources/deployment/secrets/code_pool_encryption_key_ring', 'code_pool_encryption_key_ring',
    Buffer.from(JSON.stringify({ activeKeyId: 'delivery', keys: { delivery: delivery.toString('base64') } })), 1000, 1000, 0o400)
  addDir('/sources/staging', 'staging', 0, 0, 0o700)
  addDir('/sources/staging/payload', 'payload', 0, 0, 0o700)
  repo.files.set('/sources/staging/payload/database.dump', repo.databaseDump)
  repo.nodes.push({ struct_type: 'node', path: '/sources/staging/payload/database.dump', name: 'database.dump', type: 'file', uid: process.getuid?.() ?? 501, gid: process.getgid?.() ?? appGid,
    size: repo.databaseDump.length, mode: 0o600, inode: 90001 })
  return { repo, scratch, appUid, appGid, database, keys, identityBytes: identity.identityBytes }
}

describe('direct Restic source inspection', () => {
  it('binds the raw snapshot to identity, Pending Key, Trust Store including its empty kernel lock, deployment rings, marker and dump', async () => {
    const f = await fixture()
    const result = await verifyDirectSourceSnapshot({ repo: f.repo as never, set: f.repo.set, snapshot: f.repo.snapshot,
      scratch: f.scratch, databaseDump: { size: f.repo.databaseDump.length, sha256: sha(f.repo.databaseDump) },
      database: f.database, keys: f.keys, appUid: f.appUid, appGid: f.appGid,
      inspectTrustStoreReadOnly: async () => ({ status: 'uninitialized', bundleVersion: null, artifactSha256: null,
        stateDigest: null, revokedKeyCount: 0, retiredKeyCount: 0 }), assertLock: async () => {} })
    expect(result.identityFileSha256).toBe(sha(f.identityBytes))
    expect(result.trustBundle.status).toBe('uninitialized')
    await expect(readFile(join(f.scratch, 'manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('accepts the legacy marker without the initializer newline', async () => {
    const f = await fixture()
    const markerPath = '/sources/state/.aikayun-volume-v1'
    const markerNode = f.repo.nodes.find(node => node.path === markerPath)!
    const canonical = Buffer.from('aikayun-state-volume-v1')
    markerNode.size = canonical.length
    f.repo.files.set(markerPath, canonical)
    const result = await verifyDirectSourceSnapshot({ repo: f.repo as never, set: f.repo.set, snapshot: f.repo.snapshot,
      scratch: f.scratch, databaseDump: { size: f.repo.databaseDump.length, sha256: sha(f.repo.databaseDump) },
      database: f.database, keys: f.keys, appUid: f.appUid, appGid: f.appGid,
      inspectTrustStoreReadOnly: async () => ({ status: 'uninitialized', bundleVersion: null, artifactSha256: null,
        stateDigest: null, revokedKeyCount: 0, retiredKeyCount: 0 }), assertLock: async () => {} })
    expect(result.trustBundle.status).toBe('uninitialized')
  })
  it('rejects hardlinks to protected identity files', async () => {
    const f = await fixture()
    const inode = f.repo.nodes.find(node => node.path === '/sources/state/identity/current/identity.json')?.inode as number
    f.repo.hardlink = { inode, path: '/sources/state/private-files/linked-identity' }
    await expect(verifyDirectSourceSnapshot({ repo: f.repo as never, set: f.repo.set, snapshot: f.repo.snapshot,
      scratch: f.scratch, databaseDump: { size: f.repo.databaseDump.length, sha256: sha(f.repo.databaseDump) },
      database: f.database, keys: f.keys, appUid: f.appUid, appGid: f.appGid,
      inspectTrustStoreReadOnly: async () => ({ status: 'uninitialized', bundleVersion: null, artifactSha256: null,
        stateDigest: null, revokedKeyCount: 0, retiredKeyCount: 0 }), assertLock: async () => {} })).rejects.toThrow('BACKUP_SOURCE_PATH_UNSAFE')
  })
})
