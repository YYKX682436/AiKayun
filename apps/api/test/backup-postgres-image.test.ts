import { describe, expect, it } from 'vitest'
import { isBackupPostgresImage, matchesBackupPostgresImage } from '../src/backup/postgres-image.js'

const digest = `sha256:${'a'.repeat(64)}`
describe('backup PostgreSQL image references', () => {
  it('permits the two supported digest-pinned image names', () => {
    expect(matchesBackupPostgresImage(`docker.io/library/postgres@${digest}`, digest)).toBe(true)
    expect(matchesBackupPostgresImage(`ghcr.io/yykx682436/aikayun-postgres@${digest}`, digest)).toBe(true)
  })
  it('rejects mismatched digests, foreign images, tags, and malformed references', () => {
    for (const reference of [`ghcr.io/other/aikayun-postgres@${digest}`, 'ghcr.io/yykx682436/aikayun-postgres:latest',
      `ghcr.io/yykx682436/aikayun-postgres@${digest}extra`, `docker.io/library/postgres@sha256:${'A'.repeat(64)}`]) {
      expect(isBackupPostgresImage(reference)).toBe(false)
    }
    expect(matchesBackupPostgresImage(`ghcr.io/yykx682436/aikayun-postgres@${digest}`, `sha256:${'b'.repeat(64)}`)).toBe(false)
    expect(matchesBackupPostgresImage(`ghcr.io/yykx682436/aikayun-postgres@${digest}`, undefined as unknown as string)).toBe(false)
  })
})
