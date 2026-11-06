import { describe, expect, it } from 'vitest'
import { assertSafeResticSnapshotTree } from '../src/backup/direct-source-inspection.js'
import type { LocalResticRepository } from '../src/backup/restic-local.js'

const root = '/sources/state'
const base = (path: string, type: 'dir' | 'file', inode: number, size = 0) => ({ struct_type: 'node', path, type,
  uid: 1000, gid: 1000, mode: type === 'dir' ? 0o20000000700 : 0o600, inode, size })

function repository(nodes: Array<Record<string, unknown>>): LocalResticRepository {
  return { async visitSnapshotNodes(_snapshot: string, _path: string, visitor: (node: Record<string, unknown>) => void) {
    for (const node of nodes) visitor(node)
  } } as unknown as LocalResticRepository
}

describe('direct Restic restore source path safety', () => {
  it('accepts canonical directories and regular files under the selected root', async () => {
    await expect(assertSafeResticSnapshotTree(repository([
      { ...base(root, 'dir', 1), mode: 0o20004000700 }, base(`${root}/media`, 'dir', 2),
      base(`${root}/media/public.webp`, 'file', 3, 24),
    ]), 'a'.repeat(64), root)).resolves.toBeUndefined()
  })

  it('rejects symlinks, path traversal, non-canonical paths and hardlink identities', async () => {
    const invalid = [
      [base(root, 'dir', 1), { ...base(`${root}/media/link`, 'file', 2), type: 'symlink', linktarget: '/etc/passwd' }],
      [base(root, 'dir', 1), base(`${root}/../../etc/passwd`, 'file', 2, 1)],
      [base(root, 'dir', 1), base(`${root}//media/file.bin`, 'file', 2, 1)],
      [base(root, 'dir', 1), base(`${root}/media/one.bin`, 'file', 2, 1), base(`${root}/media/two.bin`, 'file', 2, 1)],
      [base(root, 'dir', 1), { ...base(`${root}/media/setuid`, 'file', 2, 1), mode: 0o4600 }],
    ]
    for (const nodes of invalid) await expect(assertSafeResticSnapshotTree(repository(nodes), 'b'.repeat(64), root))
      .rejects.toThrow(/BACKUP_SOURCE_PATH_UNSAFE|BACKUP_SOURCE_SPECIAL_MODE_REJECTED/u)
  })

  it('requires an explicitly listed directory root', async () => {
    await expect(assertSafeResticSnapshotTree(repository([base(`${root}/media/file.bin`, 'file', 2, 1)]), 'c'.repeat(64), root))
      .rejects.toThrow('BACKUP_SOURCE_PATH_UNSAFE')
  })
})
