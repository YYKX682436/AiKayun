// Disposable real-restic test subprocess; never used as a production entry.
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { LocalResticRepository } from '../../src/backup/restic-local.js'
import { initializeEmptyRepository } from '../../src/backup/repository-initialization.js'
const root = await realpath(process.argv[2] ?? ''), binary = await realpath(process.argv[3] ?? '')
if (!root.includes('/aikayun-repo-init-') || !process.send) throw new Error('Fixture identity invalid')
class InterruptedRepository extends LocalResticRepository {
  override async initialize() {
    await super.initialize()
    process.send!({ state: 'initialized-before-marker' })
    await new Promise<void>(() => { setInterval(() => {}, 1000) })
  }
}
const repositoryDirectory = join(root, 'repo'), journalDirectory = join(root, 'journal'), publicationDirectory = join(root, 'publication'), mountRoot = join(root, 'stage')
const repository = new InterruptedRepository({ binary, repository: repositoryDirectory, passwordFile: join(root, 'synthetic-user-password') })
await initializeEmptyRepository({ repositoryDirectory, journalDirectory, publicationDirectory, mountRoot, repository, assertLock: async () => {} })
