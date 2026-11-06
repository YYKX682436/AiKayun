import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ source: vi.fn(), paths: vi.fn(), initialize: vi.fn() }))
vi.mock('../src/backup/fixed-release-source.js', () => ({ loadFixedReleaseSource: mocks.source }))
vi.mock('../src/backup/fixed-backup-paths.js', () => ({ loadFixedBackupPaths: mocks.paths }))
vi.mock('../src/backup/repository-initialization.js', () => ({ initializeEmptyRepository: mocks.initialize }))
import { runFixedRepositoryInitialization } from '../src/backup/fixed-initialization.js'
let locked = true
const host = { assertOwnedLock: vi.fn(async () => { if (!locked) throw new Error('lost lock') }) }
beforeEach(() => {
  vi.resetAllMocks(); locked = true
  host.assertOwnedLock.mockImplementation(async () => { if (!locked) throw new Error('lost lock') })
  mocks.source.mockResolvedValue({ host, readAuthenticatedRelease: async () => ({}) })
  mocks.paths.mockResolvedValue({ repositoryDirectory: '/fixed/repository', journalDirectory: '/fixed/journal', publicationDirectory: '/fixed/publications', mountRoot: '/fixed/staging', repository: {} })
  mocks.initialize.mockResolvedValue(undefined)
})
it('only initializes the fixed pre-provisioned paths with lock and signature proof', async () => {
  await expect(runFixedRepositoryInitialization(new AbortController().signal)).resolves.toEqual({ state: 'initialized' })
  expect(mocks.initialize).toHaveBeenCalledWith(expect.objectContaining({ repositoryDirectory: '/fixed/repository', journalDirectory: '/fixed/journal', assertLock: expect.any(Function) }))
})
it('does not generate credentials or attempt initialization when fixed credential loading fails', async () => {
  mocks.paths.mockRejectedValueOnce(new Error('missing password'))
  await expect(runFixedRepositoryInitialization(new AbortController().signal)).rejects.toThrow('missing password')
  expect(mocks.initialize).not.toHaveBeenCalled()
})
it('does not report initialization when an active operation loses its lock', async () => {
  mocks.initialize.mockImplementationOnce(async input => {
    locked = false
    await input.assertLock()
  })
  await expect(runFixedRepositoryInitialization(new AbortController().signal)).rejects.toThrow('lost lock')
}, 5000)
