import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { copyProductionVerifiedSnapshotToS3, copyVerifiedSnapshotToS3, inspectRemoteCopyAttempt, validateS3Destination, type S3CopyConfiguration } from '../src/backup/remote-copy.js'
import { verifyPublishedSnapshot } from '../src/backup/publish-set.js'
import { verifyPostgresDumpBinding } from '../src/backup/pg-dump.js'

vi.mock('../src/backup/publish-set.js', () => ({
  verifyPublishedSnapshot: vi.fn(async input => {
    await input.assertSecureStorage()
    await input.verifyDumpBinding('/synthetic-fixture-only', { databaseId: 'synthetic' })
    return { status: 'verified', snapshotId: 'a'.repeat(64), manifest: { status: 'candidate', backup_set_id: input.backupSetId } }
  }),
}))
vi.mock('../src/backup/pg-dump.js', () => ({ verifyPostgresDumpBinding: vi.fn(async () => {}) }))

const roots: string[] = []
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aikayun-remote-copy-')))
  roots.push(root)
  const repository = join(root, 'repository'), scratch = join(root, 'scratch'), publications = join(root, 'publications'), remoteStatus = join(root, 'remote-status')
  await mkdir(repository, { mode: 0o700 })
  await mkdir(scratch, { mode: 0o700 })
  await mkdir(publications, { mode: 0o700 })
  await mkdir(remoteStatus, { mode: 0o700 })
  await writeFile(join(repository, 'original'), 'local-repository-data')
  const localPassword = join(root, 'local-password'), remotePassword = join(root, 'remote-password'), credentials = join(root, 'credentials')
  await writeFile(localPassword, 'test-local-password', { mode: 0o600 })
  await writeFile(remotePassword, 'test-remote-password', { mode: 0o600 })
  await writeFile(credentials, JSON.stringify({ accessKeyId: 'test-access', secretAccessKey: 'test-secret' }), { mode: 0o600 })
  const binary = join(root, 'fake-restic')
  const config: S3CopyConfiguration = { binary, localRepository: repository, localPasswordFile: localPassword,
    remoteHttpsUrl: 'https://s3.example.invalid/test-bucket/backup', remotePasswordFile: remotePassword,
    credentialsFile: credentials, publicationDirectory: publications, remoteStatusDirectory: remoteStatus, scratchParent: scratch, tarBinary: '/usr/bin/tar',
    maxExtractBytes: 10000, timeoutMs: 1000, assertSecureStorage: async () => {}, assertLock: async () => {},
    verifyDumpBinding: async (directory, metadata) => { if (directory !== '/synthetic-fixture-only' || metadata.databaseId !== 'synthetic') throw new Error('fixture dump mismatch') } }
  return { root, config }
}

describe('controlled remote copy', () => {
  it('rejects insecure, ambiguous, credential-bearing and unsafe URLs', () => {
    for (const url of ['http://example.com/bucket', 'https://x:y@example.com/bucket', 'https://example.com/bucket?token=secret',
      'https://example.com/a', 'https://example.com/bucket/../other', 'https://example.com/bucket/%2e%2e/other']) {
      expect(() => validateS3Destination(url)).toThrow('REMOTE_REPOSITORY_INVALID')
    }
    expect(validateS3Destination('https://s3.example.invalid/test-bucket/a')).toBe('s3:https://s3.example.invalid/test-bucket/a')
  })
  it('reports copy failure without exposing secrets or changing the local repository', async () => {
    const { config } = await fixture()
    await writeFile(config.binary, '#!/bin/sh\nprintf "%s\\n" "$AWS_SECRET_ACCESS_KEY" >&2\nexit 9\n', { mode: 0o700 })
    const set = randomUUID()
    const error = await copyVerifiedSnapshotToS3(config, set, 'a'.repeat(64)).catch(error => error as Error)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('REMOTE_COPY_FAILED')
    expect((error as Error).message).not.toContain('test-secret')
    expect(await readFile(join(config.localRepository, 'original'), 'utf8')).toBe('local-repository-data')
    expect(await import('node:fs/promises').then(fs => fs.readdir(config.scratchParent))).toEqual([])
    const records = await import('node:fs/promises').then(fs => fs.readdir(config.remoteStatusDirectory))
    expect(records).toHaveLength(1)
    expect(JSON.parse(await readFile(join(config.remoteStatusDirectory, records[0]!), 'utf8')).state).toBe('uploading')
    expect(await inspectRemoteCopyAttempt(config, set)).toBe('requires_review')
    await expect(copyVerifiedSnapshotToS3(config, set, 'a'.repeat(64))).rejects.toThrow('REMOTE_COPY_ALREADY_ATTEMPTED')
  })
  it('checks copied snapshot lineage and passes secrets only via environment and descriptors', async () => {
    const { config } = await fixture()
    const set = randomUUID(), snapshot = 'a'.repeat(64), remote = 'b'.repeat(64)
    await writeFile(config.binary, `#!/bin/sh\ncase "$*" in *test-secret*|*test-local-password*|*test-remote-password*) exit 10;; esac\n[ "$AWS_ACCESS_KEY_ID" = test-access ] && [ "$AWS_SECRET_ACCESS_KEY" = test-secret ] || exit 11\n[ "$(cat /dev/fd/3)" = test-local-password ] && [ "$(cat /dev/fd/4)" = test-remote-password ] || exit 12\ncase "$*" in *snapshots*) printf '%s\\n' '[{"id":"${remote}","original":"${snapshot}","tags":["aikayun-set-${set}"]}]';; esac\n`, { mode: 0o700 })
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'must-not-inherit')
    expect(await copyVerifiedSnapshotToS3(config, set, snapshot)).toBe(remote)
    expect(await readFile(join(config.localRepository, 'original'), 'utf8')).toBe('local-repository-data')
    const records = await import('node:fs/promises').then(fs => fs.readdir(config.remoteStatusDirectory))
    expect(JSON.parse(await readFile(join(config.remoteStatusDirectory, records[0]!), 'utf8'))).toMatchObject({ set, source: snapshot, remote, state: 'verified' })
    expect(await inspectRemoteCopyAttempt(config, set)).toBe('last_copy_verified')
    await expect(copyVerifiedSnapshotToS3(config, set, snapshot)).rejects.toThrow('REMOTE_COPY_ALREADY_ATTEMPTED')
  })
  it('rejects credential links and loose permissions before invoking restic', async () => {
    const { root, config } = await fixture()
    await writeFile(config.binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    await chmod(config.credentialsFile, 0o644)
    await expect(copyVerifiedSnapshotToS3(config, randomUUID(), 'a'.repeat(64))).rejects.toThrow('REMOTE_SECRET_INVALID')
    await chmod(config.credentialsFile, 0o600)
    const link = join(root, 'link')
    await symlink(config.credentialsFile, link)
    await expect(copyVerifiedSnapshotToS3({ ...config, credentialsFile: link }, randomUUID(), 'a'.repeat(64))).rejects.toThrow('RESTIC_PATH_INVALID')
    await expect(copyVerifiedSnapshotToS3({ ...config, remoteStatusDirectory: config.publicationDirectory }, randomUUID(), 'a'.repeat(64)))
      .rejects.toThrow('REMOTE_STATUS_LOCATION_INVALID')
  })
  it('rejects a remote result whose origin does not match the selected local snapshot', async () => {
    const { config } = await fixture()
    const set = randomUUID(), snapshot = 'a'.repeat(64)
    await writeFile(config.binary, `#!/bin/sh\ncase "$*" in *snapshots*) printf '%s\\n' '[{"id":"${'b'.repeat(64)}","original":"${'c'.repeat(64)}","tags":["aikayun-set-${set}"]}]';; esac\n`, { mode: 0o700 })
    await expect(copyVerifiedSnapshotToS3(config, set, snapshot)).rejects.toThrow('REMOTE_COPY_NOT_VERIFIED')
    expect(await readFile(join(config.localRepository, 'original'), 'utf8')).toBe('local-repository-data')
  })
  it('does not report success if remote data cannot be read back after copy', async () => {
    const { config } = await fixture()
    await writeFile(config.binary, '#!/bin/sh\ncase "$*" in *check*) exit 3;; esac\nexit 0\n', { mode: 0o700 })
    await expect(copyVerifiedSnapshotToS3(config, randomUUID(), 'a'.repeat(64))).rejects.toThrow('REMOTE_COPY_FAILED')
    expect(await readFile(join(config.localRepository, 'original'), 'utf8')).toBe('local-repository-data')
  })
  it('does not invoke remote copy when publication verification is absent, incomplete or mismatched', async () => {
    const { root, config } = await fixture()
    const marker = join(root, 'remote-was-called')
    await writeFile(config.binary, `#!/bin/sh\ntouch '${marker}'\nexit 0\n`, { mode: 0o700 })
    vi.mocked(verifyPublishedSnapshot).mockRejectedValueOnce(new Error('BACKUP_PUBLICATION_NOT_VERIFIED'))
    await expect(copyVerifiedSnapshotToS3(config, randomUUID(), 'a'.repeat(64))).rejects.toThrow('REMOTE_SOURCE_NOT_VERIFIED')
    await expect(readFile(marker)).rejects.toThrow()
    await expect(copyVerifiedSnapshotToS3(config, randomUUID(), 'b'.repeat(64))).rejects.toThrow('REMOTE_SOURCE_NOT_VERIFIED')
    await expect(readFile(marker)).rejects.toThrow()
  })
  it('requires the dump verifier and refuses a failed binding check', async () => {
    const { root, config } = await fixture()
    const marker = join(root, 'remote-was-called')
    await writeFile(config.binary, `#!/bin/sh\ntouch '${marker}'\nexit 0\n`, { mode: 0o700 })
    await expect(copyVerifiedSnapshotToS3({ ...config, verifyDumpBinding: undefined } as unknown as S3CopyConfiguration,
      randomUUID(), 'a'.repeat(64))).rejects.toThrow('REMOTE_COPY_ARGUMENT_INVALID')
    await expect(copyVerifiedSnapshotToS3({ ...config, verifyDumpBinding: async () => { throw new Error('binding mismatch') } },
      randomUUID(), 'a'.repeat(64))).rejects.toThrow('REMOTE_SOURCE_NOT_VERIFIED')
    await expect(readFile(marker)).rejects.toThrow()
  })
  it('production wrapper always calls the pg_restore-based verifier and refuses its failure', async () => {
    const { root, config } = await fixture()
    const marker = join(root, 'remote-was-called')
    await writeFile(config.binary, `#!/bin/sh\ntouch '${marker}'\nexit 0\n`, { mode: 0o700 })
    const { verifyDumpBinding: _syntheticVerifier, ...production } = config
    const pgDumpTarget = { dockerBinary: '/usr/bin/docker', dockerSocket: '/run/docker.sock', containerId: 'a'.repeat(64),
      database: 'aikayun', user: 'aikayun_bootstrap', assertSecureStaging: async () => {} }
    vi.mocked(verifyPostgresDumpBinding).mockRejectedValueOnce(new Error('fixture mismatch'))
    await expect(copyProductionVerifiedSnapshotToS3({ ...production, pgDumpTarget }, randomUUID(), 'a'.repeat(64)))
      .rejects.toThrow('REMOTE_SOURCE_NOT_VERIFIED')
    expect(vi.mocked(verifyPostgresDumpBinding)).toHaveBeenCalledWith(expect.objectContaining({
      containerId: 'a'.repeat(64), stagingDirectory: '/synthetic-fixture-only',
    }), expect.objectContaining({ databaseId: 'synthetic' }))
    await expect(readFile(marker)).rejects.toThrow()
  })
  it('read-only inspection treats malformed or interrupted markers as needing review', async () => {
    const { config } = await fixture()
    const set = randomUUID()
    expect(await inspectRemoteCopyAttempt(config, set)).toBe('not_attempted')
    await writeFile(config.binary, '#!/bin/sh\nexit 1\n', { mode: 0o700 })
    await expect(copyVerifiedSnapshotToS3(config, set, 'a'.repeat(64))).rejects.toThrow('REMOTE_COPY_FAILED')
    const [name] = await import('node:fs/promises').then(fs => fs.readdir(config.remoteStatusDirectory))
    await writeFile(join(config.remoteStatusDirectory, name!), '{broken', { mode: 0o600 })
    expect(await inspectRemoteCopyAttempt(config, set)).toBe('requires_review')
    await expect(copyVerifiedSnapshotToS3(config, set, 'a'.repeat(64))).rejects.toThrow('REMOTE_COPY_ALREADY_ATTEMPTED')
  })
  it('interrupts an in-flight copy if the deployment lock is lost and leaves an uncertain durable record', async () => {
    const { config } = await fixture()
    await writeFile(config.binary, '#!/bin/sh\nexec sleep 30\n', { mode: 0o700 })
    let checks = 0
    config.timeoutMs = 5000
    config.assertLock = async () => { if (++checks > 4) throw new Error('private lock failure') }
    const set = randomUUID()
    await expect(copyVerifiedSnapshotToS3(config, set, 'a'.repeat(64))).rejects.toThrow('REMOTE_COPY_LOCK_UNVERIFIED')
    expect(await inspectRemoteCopyAttempt({ ...config, assertLock: async () => {} }, set)).toBe('requires_review')
    expect(await readFile(join(config.localRepository, 'original'), 'utf8')).toBe('local-repository-data')
  }, 10_000)
  it('does not expose raw paths or underlying error details in public failures', async () => {
    const { root, config } = await fixture()
    await writeFile(config.binary, '#!/bin/sh\nexit 1\n', { mode: 0o700 })
    const secretPath = join(root, 'private-customer-credential-marker')
    const error = await copyVerifiedSnapshotToS3({ ...config, credentialsFile: secretPath }, randomUUID(), 'a'.repeat(64)).catch(error => error as Error)
    expect((error as Error).message).toBe('REMOTE_COPY_UNAVAILABLE')
    expect(String((error as Error).stack)).not.toContain('private-customer-credential-marker')
    const statusError = await inspectRemoteCopyAttempt({ ...config, remoteStatusDirectory: secretPath }, randomUUID()).catch(error => error as Error)
    expect((statusError as Error).message).toBe('REMOTE_STATUS_UNAVAILABLE')
    expect(String((statusError as Error).stack)).not.toContain('private-customer-credential-marker')
  })
})
