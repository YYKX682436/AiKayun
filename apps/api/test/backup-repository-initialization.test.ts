import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { initializeEmptyRepository, assertInitializedRepository } from '../src/backup/repository-initialization.js'
import type { LocalResticRepository } from '../src/backup/restic-local.js'
import { UnsafeMaintenanceRecoveryError } from '../src/backup/maintenance-errors.js'
let root: string, repositoryDirectory: string, journalDirectory: string, publicationDirectory: string, mountRoot: string
const id = 'a'.repeat(64)
const lock = vi.fn(async () => {})
const repository = { assertRepositoryPath: vi.fn(async () => {}), assertSeparatedStorage: vi.fn(async () => {}),
  initialize: vi.fn(async () => {}), repositoryIdentity: vi.fn(async () => id), check: vi.fn(async () => {}), snapshots: vi.fn(async () => []) } as unknown as LocalResticRepository
const input = () => ({ repositoryDirectory, journalDirectory, publicationDirectory, mountRoot, repository, assertLock: lock })
beforeEach(async () => {
  vi.clearAllMocks(); root = await realpath(await mkdtemp(join(tmpdir(), 'aikayun-repo-init-')))
  repositoryDirectory = join(root, 'repo'); journalDirectory = join(root, 'journal'); publicationDirectory = join(root, 'publication'); mountRoot = join(root, 'stage')
  for (const dir of [repositoryDirectory, journalDirectory, publicationDirectory, mountRoot]) await mkdir(dir, { mode: 0o700 })
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
describe('explicit repository initialization', () => {
  it('initializes once, records a verified identity and never creates credentials', async () => {
    await initializeEmptyRepository(input())
    expect(JSON.parse(await readFile(join(journalDirectory, 'repository-initialization.json'), 'utf8'))).toEqual({ schema: 1, state: 'verified', repositoryId: id })
    await expect(assertInitializedRepository(input())).resolves.toBeUndefined()
    await expect(initializeEmptyRepository(input())).rejects.toThrow('BACKUP_REPOSITORY_NOT_EMPTY')
    expect(repository.initialize).toHaveBeenCalledTimes(1)
    expect((await readdir(root)).sort()).toEqual(['journal', 'publication', 'repo', 'stage'])
  })
  it('never starts when repository, maintenance state, publications or staging already exist', async () => {
    for (const directory of [repositoryDirectory, journalDirectory, publicationDirectory, mountRoot]) {
      await writeFile(join(directory, 'existing'), 'untouched', { mode: 0o600 })
      await expect(initializeEmptyRepository(input())).rejects.toThrow('BACKUP_REPOSITORY_NOT_EMPTY')
      expect(await readFile(join(directory, 'existing'), 'utf8')).toBe('untouched')
      await rm(join(directory, 'existing'))
    }
    expect(repository.initialize).not.toHaveBeenCalled()
  })
  it('leaves an uncertain durable marker and refuses an automatic retry after an unknown result', async () => {
    vi.mocked(repository.initialize).mockImplementationOnce(async () => { await writeFile(join(repositoryDirectory, 'config'), 'unknown'); throw new Error('private restic output') })
    await expect(initializeEmptyRepository(input())).rejects.toBeInstanceOf(UnsafeMaintenanceRecoveryError)
    expect(JSON.parse(await readFile(join(journalDirectory, 'repository-initialization.json'), 'utf8'))).toEqual({ schema: 1, state: 'initializing' })
    await expect(initializeEmptyRepository(input())).rejects.toThrow('BACKUP_REPOSITORY_NOT_EMPTY')
    await expect(assertInitializedRepository(input())).rejects.toThrow('BACKUP_REPOSITORY_INIT_UNCERTAIN')
    expect(repository.initialize).toHaveBeenCalledTimes(1)
  })
  it('rejects a replaced repository or missing/wrong marker without exposing secrets', async () => {
    await initializeEmptyRepository(input())
    vi.mocked(repository.repositoryIdentity).mockResolvedValueOnce('b'.repeat(64))
    await expect(assertInitializedRepository(input())).rejects.toThrow('BACKUP_REPOSITORY_INIT_UNCERTAIN')
    await writeFile(join(journalDirectory, 'repository-initialization.json'), '{"schema":1,"state":"verified","repositoryId":"bad"}', { mode: 0o600 })
    await expect(assertInitializedRepository(input())).rejects.toThrow('BACKUP_REPOSITORY_INIT_UNCERTAIN')
  })
})

describe.skipIf(!process.env.AIKAYUN_TEST_RESTIC)('real restic repository initialization', () => {
  it('retains an uncertain marker after SIGKILL immediately following a real restic init', async () => {
    const password = join(root, 'synthetic-user-password')
    await writeFile(password, 'fixture-only-secret', { mode: 0o600 })
    const binary = await realpath(process.env.AIKAYUN_TEST_RESTIC!)
    const child = spawn(process.execPath, ['--import', 'tsx', join(process.cwd(), 'test/fixtures/backup-repository-init-kill.ts'), root, binary],
      { env: { ...process.env, NODE_ENV: 'test' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    child.stderr!.resume()
    try {
      const exited = once(child, 'exit')
      const [message] = await Promise.race([once(child, 'message'), exited.then(() => { throw new Error('fixture exited early') }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('fixture timed out')), 30000).unref())])
      expect(message).toEqual({ state: 'initialized-before-marker' })
      child.kill('SIGKILL')
      const [, signal] = await exited
      expect(signal).toBe('SIGKILL')
      expect(JSON.parse(await readFile(join(journalDirectory, 'repository-initialization.json'), 'utf8'))).toEqual({ schema: 1, state: 'initializing' })
      const real = new (await import('../src/backup/restic-local.js')).LocalResticRepository({ binary, repository: repositoryDirectory, passwordFile: password })
      expect(await real.repositoryIdentity()).toMatch(/^[a-f0-9]{64}$/)
      const actual = { ...input(), repository: real }
      await expect(assertInitializedRepository(actual)).rejects.toThrow('BACKUP_REPOSITORY_INIT_UNCERTAIN')
      await expect(initializeEmptyRepository(actual)).rejects.toThrow('BACKUP_REPOSITORY_NOT_EMPTY')
      expect(await readFile(password, 'utf8')).toBe('fixture-only-secret')
    } finally {
      if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited }
    }
  }, 60000)
  it('initializes only an empty isolated repository with a separate pre-existing password', async () => {
    const password = join(root, 'synthetic-user-password')
    await writeFile(password, 'fixture-only-secret', { mode: 0o600 })
    const real = new (await import('../src/backup/restic-local.js')).LocalResticRepository({
      binary: process.env.AIKAYUN_TEST_RESTIC!, repository: repositoryDirectory, passwordFile: password })
    const actual = { ...input(), repository: real }
    await initializeEmptyRepository(actual)
    await expect(assertInitializedRepository(actual)).resolves.toBeUndefined()
    expect(await readFile(password, 'utf8')).toBe('fixture-only-secret')
    expect(await real.snapshots()).toEqual([])
    await expect(initializeEmptyRepository(actual)).rejects.toThrow('BACKUP_REPOSITORY_NOT_EMPTY')
  }, 120000)
})
