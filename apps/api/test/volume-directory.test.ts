import { mkdtemp, mkdir, readlink, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { initializeVolumeDirectory } from '../src/ops/volume-directory.js'

describe('volume directory initializer', () => {
  let root = ''

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
    root = ''
  })

  it('creates an owned, restricted volume directory without replacing existing content', async () => {
    root = await mkdtemp(join(tmpdir(), 'aikayun-volume-init-'))
    const directory = join(root, 'state', 'private-files')
    const ownerUid = process.getuid?.()
    const ownerGid = process.getgid?.()
    if (ownerUid === undefined || ownerGid === undefined) throw new Error('POSIX uid/gid are required for this test')
    await initializeVolumeDirectory(directory, 0o700, ownerUid, ownerGid)

    const info = await stat(directory)
    expect(info.isDirectory()).toBe(true)
    expect(info.uid).toBe(ownerUid)
    expect(info.gid).toBe(ownerGid)
    expect(info.mode & 0o777).toBe(0o700)
  })

  it('rejects a symlink as the volume directory', async () => {
    root = await mkdtemp(join(tmpdir(), 'aikayun-volume-init-'))
    const target = join(root, 'target')
    const link = join(root, 'link')
    await mkdir(target)
    await symlink(target, link)
    const ownerUid = process.getuid?.()
    const ownerGid = process.getgid?.()
    if (ownerUid === undefined || ownerGid === undefined) throw new Error('POSIX uid/gid are required for this test')

    await expect(initializeVolumeDirectory(link, 0o700, ownerUid, ownerGid)).rejects.toThrow()
    expect(await readlink(link)).toBe(target)
  })

  it('rejects relative paths and permissions outside the fixed allowlist', async () => {
    await expect(initializeVolumeDirectory('relative/path', 0o700)).rejects.toThrow('VOLUME_INITIALIZATION_ARGUMENT_INVALID')
    await expect(initializeVolumeDirectory('/tmp/aikayun-not-created', 0o777)).rejects.toThrow('VOLUME_INITIALIZATION_ARGUMENT_INVALID')
  })
})
