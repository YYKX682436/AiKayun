import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { LocalResticRepository } from '../src/backup/restic-local.js'

const binary = process.env.AIKAYUN_TEST_RESTIC
const roots: string[] = []
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aikayun-restic-local-')))
  roots.push(root)
  const repository = join(root, 'repository')
  const source = join(root, 'set')
  const passwordFile = join(root, 'secret')
  await mkdir(repository, { mode: 0o700 })
  await mkdir(source, { mode: 0o700 })
  await writeFile(passwordFile, 'temporary-test-only-password\n', { mode: 0o600 })
  await writeFile(join(source, 'private-fixture'), 'confidential-marker-7-5a')
  return { root, source, repository, passwordFile }
}

describe.skipIf(!binary)('local restic with a separately supplied verified binary', () => {
  it('encrypts, lists and checks a set without writing the password into the repository', async () => {
    const f = await fixture()
    const repo = new LocalResticRepository({ binary: binary!, repository: f.repository, passwordFile: f.passwordFile })
    vi.stubEnv('RESTIC_PASSWORD', 'not-the-password')
    vi.stubEnv('RESTIC_REPOSITORY', '/a-path-that-must-not-be-used')
    await repo.initialize()
    const set = randomUUID()
    const id = await repo.backup(f.source, set)
    expect(id).toMatch(/^[a-f0-9]{64}$/)
    expect(await repo.snapshots()).toContain(id)
    expect(await repo.snapshotsForSet(set)).toEqual([id])
    expect(await repo.snapshotsForSet(randomUUID())).toEqual([])
    await expect(repo.backup(f.source, set)).rejects.toThrow('RESTIC_SET_ALREADY_EXISTS')
    await repo.check()
    expect((await readFile(join(f.repository, 'config'))).includes(Buffer.from('temporary-test-only-password'))).toBe(false)
    await expect(repo.initialize()).rejects.toThrow('RESTIC_REPOSITORY_NOT_EMPTY')
    const dirs = await readdir(join(f.repository, 'data'))
    let packPath = ''
    for (const dir of dirs) {
      const pack = (await readdir(join(f.repository, 'data', dir)))[0]
      if (pack) { packPath = join(f.repository, 'data', dir, pack); break }
    }
    expect(packPath).not.toBe('')
    const data = await readFile(packPath)
    expect(data.includes(Buffer.from('confidential-marker-7-5a'))).toBe(false)
    data[0] = data[0]! ^ 1
    await chmod(packPath, 0o600)
    await writeFile(packPath, data)
    await expect(repo.check()).rejects.toThrow('RESTIC_COMMAND_FAILED')
    await writeFile(f.passwordFile, 'wrong-password', { mode: 0o600 })
    await expect(repo.snapshots()).rejects.toThrow('RESTIC_COMMAND_FAILED')
  }, 60_000)
  it('keeps source and manifest snapshots distinct under one backup set ID', async () => {
    const f = await fixture()
    const repo = new LocalResticRepository({ binary: binary!, repository: f.repository, passwordFile: f.passwordFile })
    await repo.initialize()
    const set = randomUUID()
    const source = await repo.backupRole(f.source, set, 'source')
    const manifest = await repo.backupRole(f.source, set, 'manifest')
    expect(source).not.toBe(manifest)
    expect(await repo.snapshotsForRole(set, 'source')).toEqual([source])
    expect(await repo.snapshotsForRole(set, 'manifest')).toEqual([manifest])
    await expect(repo.backupRole(f.source, set, 'source')).rejects.toThrow('RESTIC_SET_ROLE_ALREADY_EXISTS')
  }, 60_000)
  it('rejects embedded passwords, symlinks, loose permissions and overlapping staging', async () => {
    const f = await fixture()
    const make = (passwordFile: string) => new LocalResticRepository({ binary: binary!, repository: f.repository, passwordFile })
    const embedded = join(f.repository, 'secret')
    await writeFile(embedded, 'password', { mode: 0o600 })
    await expect(make(embedded).snapshots()).rejects.toThrow('RESTIC_PASSWORD_LOCATION_INVALID')
    await rm(embedded)
    const linked = join(f.root, 'link')
    await symlink(f.passwordFile, linked)
    await expect(make(linked).initialize()).rejects.toThrow('RESTIC_PATH_INVALID')
    await chmod(f.passwordFile, 0o644)
    await expect(make(f.passwordFile).initialize()).rejects.toThrow('RESTIC_PASSWORD_FILE_INVALID')
    await chmod(f.passwordFile, 0o600)
    await make(f.passwordFile).initialize()
    await expect(make(f.passwordFile).backup(f.root, randomUUID())).rejects.toThrow('RESTIC_SOURCE_LOCATION_INVALID')
    await chmod(f.source, 0o755)
    await expect(make(f.passwordFile).backup(f.source, randomUUID())).rejects.toThrow('RESTIC_DIRECTORY_UNSAFE')
    await chmod(f.source, 0o700)
    await chmod(f.root, 0o777)
    await expect(make(f.passwordFile).snapshots()).rejects.toThrow('RESTIC_ANCESTOR_UNSAFE')
    await chmod(f.root, 0o700)
  }, 60_000)
})

describe('restic subprocess limits', () => {
  it('rejects publication and scratch paths overlapping the repository or password', async () => {
    const f = await fixture()
    const repo = new LocalResticRepository({ binary: '/unused', repository: f.repository, passwordFile: f.passwordFile })
    await expect(repo.assertSeparatedStorage([f.source])).resolves.toBeUndefined()
    await expect(repo.assertSeparatedStorage([f.repository])).rejects.toThrow('RESTIC_STORAGE_OVERLAP')
    await expect(repo.assertSeparatedStorage([f.root])).rejects.toThrow('RESTIC_STORAGE_OVERLAP')
    const inside = join(f.repository, 'publication')
    await mkdir(inside, { mode: 0o700 })
    await expect(repo.assertSeparatedStorage([inside])).rejects.toThrow('RESTIC_STORAGE_OVERLAP')
  })
  it('interrupts a long restic process and does not start after cancellation', async () => {
    const f = await fixture()
    const fake = join(f.root, 'fake-restic'), pidFile = join(f.root, 'pid')
    await writeFile(fake, `#!/bin/sh\nprintf '%s' "$$" > '${pidFile}'\nexec sleep 30\n`, { mode: 0o700 })
    const controller = new AbortController()
    const repo = new LocalResticRepository({ binary: fake, repository: f.repository, passwordFile: f.passwordFile, signal: controller.signal })
    const pending = repo.snapshots()
    for (let attempt = 0; attempt < 40; attempt++) {
      try { await readFile(pidFile); break } catch { await new Promise(resolve => setTimeout(resolve, 25)) }
    }
    const pid = Number(await readFile(pidFile, 'utf8'))
    controller.abort()
    await expect(pending).rejects.toThrow('RESTIC_COMMAND_INTERRUPTED')
    expect(() => process.kill(pid, 0)).toThrow()
    await rm(pidFile)
    await expect(repo.snapshots()).rejects.toThrow('RESTIC_COMMAND_INTERRUPTED')
    await expect(readFile(pidFile)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 10_000)
  it('times out stalled commands and bounds output without exposing it', async () => {
    const f = await fixture()
    const fake = join(f.root, 'fake-restic')
    await writeFile(fake, '#!/bin/sh\nexec sleep 30\n', { mode: 0o700 })
    const repo = new LocalResticRepository({ binary: fake, repository: f.repository, passwordFile: f.passwordFile, timeoutMs: 100 })
    await expect(repo.snapshots()).rejects.toThrow('RESTIC_COMMAND_TIMEOUT')
    await writeFile(fake, '#!/bin/sh\nexec yes confidential-marker-7-5a\n', { mode: 0o700 })
    await expect(repo.snapshots()).rejects.toThrow('RESTIC_COMMAND_FAILED')
    await chmod(fake, 0o777)
    await expect(repo.snapshots()).rejects.toThrow('RESTIC_EXECUTABLE_UNSAFE')
  }, 10_000)
})
