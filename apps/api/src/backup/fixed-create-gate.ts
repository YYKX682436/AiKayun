import { opendir } from 'node:fs/promises'
import { readMaintenanceJournal } from './journal.js'
import { readDirectPublicationRecord } from './direct-publish-set.js'
import type { LocalResticRepository } from './restic-local.js'
import { assertInitializedRepository } from './repository-initialization.js'

const setId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const digest = /^[a-f0-9]{64}$/

/** A fresh create must not turn an uncertain upload into an implicit retry
 * under a different UUID. Inspect only the fixed dedicated local repository;
 * it never removes, retries, repairs or changes any existing backup. */
export async function assertNoUncertainBackupState(input: {
  repositoryDirectory: string; journalDirectory: string; publicationDirectory: string; mountRoot: string; repository: LocalResticRepository; assertLock(): Promise<void>
}): Promise<void> {
  try {
    await input.assertLock()
    await assertInitializedRepository(input)
    await input.repository.assertSeparatedStorage([input.journalDirectory, input.publicationDirectory, input.mountRoot])
    const journal = await readMaintenanceJournal(input.journalDirectory)
    if (journal && journal.phase !== 'complete') throw new Error('unresolved maintenance')
    const stage = await opendir(input.mountRoot)
    for await (const _entry of stage) throw new Error('unresolved staging')
    const publications = new Map<string, { sourceSnapshot: string; manifestSnapshot: string }>()
    let count = 0
    const directory = await opendir(input.publicationDirectory)
    for await (const entry of directory) {
      if (++count > 10000) throw new Error('publication limit')
      const match = /^([0-9a-f-]{36})\.json$/.exec(entry.name)
      if (!match || !setId.test(match[1]!)) throw new Error('unknown publication')
      await input.assertLock()
      const record = await readDirectPublicationRecord(input.publicationDirectory, match[1]!)
      if (!record) throw new Error('incomplete publication')
      publications.set(match[1]!, record)
    }
    const snapshots: unknown = await input.repository.allSnapshotMetadata()
    if (!Array.isArray(snapshots) || snapshots.length > 10000 || snapshots.length !== publications.size * 2) throw new Error('unknown snapshots')
    const seen = new Map<string, { source: string[]; manifest: string[] }>()
    for (const value of snapshots) {
      if (!value || typeof value !== 'object' || Array.isArray(value) || !('id' in value) || typeof value.id !== 'string' || !digest.test(value.id) ||
          !('tags' in value) || !Array.isArray(value.tags) || !value.tags.every((tag: unknown) => typeof tag === 'string')) throw new Error('invalid snapshot')
      const tags = value.tags as string[]
      const setTags = tags.filter(tag => tag.startsWith('aikayun-set-'))
      const roleTags = tags.filter(tag => tag === 'aikayun-role-source' || tag === 'aikayun-role-manifest')
      const set = setTags.length === 1 ? setTags[0]!.slice('aikayun-set-'.length) : ''
      if (!setId.test(set) || roleTags.length !== 1 || !publications.has(set)) throw new Error('untracked snapshot')
      const pair = seen.get(set) ?? { source: [], manifest: [] }
      if (roleTags[0] === 'aikayun-role-source') pair.source.push(value.id)
      else pair.manifest.push(value.id)
      seen.set(set, pair)
    }
    for (const [set, record] of publications) {
      const pair = seen.get(set)
      if (!pair || pair.source.length !== 1 || pair.manifest.length !== 1 || pair.source[0] !== record.sourceSnapshot ||
          pair.manifest[0] !== record.manifestSnapshot) throw new Error('untracked snapshot')
    }
    await input.assertLock()
  } catch { throw new Error('BACKUP_PREVIOUS_ATTEMPT_REQUIRES_REVIEW') }
}
