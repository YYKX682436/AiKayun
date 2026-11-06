import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { copyVerifiedSnapshotToS3, type S3CopyConfiguration } from '../src/backup/remote-copy.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

it('the real publication verifier prevents a missing or uploading candidate from reaching restic copy', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aikayun-remote-publication-')))
  roots.push(root)
  const repository = join(root, 'repository'), scratch = join(root, 'scratch'), publications = join(root, 'publications'), remoteStatus = join(root, 'remote-status')
  for (const path of [repository, scratch, publications, remoteStatus]) await mkdir(path, { mode: 0o700 })
  await writeFile(join(repository, 'original'), 'unchanged')
  const local = join(root, 'local-password'), remote = join(root, 'remote-password'), credentials = join(root, 'credentials')
  await writeFile(local, 'local-test-secret', { mode: 0o600 })
  await writeFile(remote, 'remote-test-secret', { mode: 0o600 })
  await writeFile(credentials, JSON.stringify({ accessKeyId: 'test-access', secretAccessKey: 'test-secret' }), { mode: 0o600 })
  const binary = join(root, 'fake-restic'), marker = join(root, 'restic-invoked')
  await writeFile(binary, `#!/bin/sh\ntouch '${marker}'\nexit 0\n`, { mode: 0o700 })
  const config: S3CopyConfiguration = { binary, localRepository: repository, localPasswordFile: local,
    remoteHttpsUrl: 'https://s3.example.invalid/test-bucket/backup', remotePasswordFile: remote,
    credentialsFile: credentials, publicationDirectory: publications, remoteStatusDirectory: remoteStatus, scratchParent: scratch, tarBinary: '/usr/bin/tar',
    maxExtractBytes: 1024, timeoutMs: 1000, assertSecureStorage: async () => {}, assertLock: async () => {},
    verifyDumpBinding: async () => { throw new Error('fixture must reject before dump verification') } }
  const set = randomUUID()
  await expect(copyVerifiedSnapshotToS3(config, set, 'a'.repeat(64))).rejects.toThrow('REMOTE_SOURCE_NOT_VERIFIED')
  await writeFile(join(publications, `${set}.json`), JSON.stringify({ schema: 1, set, state: 'uploading' }), { mode: 0o600 })
  await expect(copyVerifiedSnapshotToS3(config, set, 'a'.repeat(64))).rejects.toThrow('REMOTE_SOURCE_NOT_VERIFIED')
  await expect(readFile(marker)).rejects.toThrow()
  expect(await readFile(join(repository, 'original'), 'utf8')).toBe('unchanged')
})
