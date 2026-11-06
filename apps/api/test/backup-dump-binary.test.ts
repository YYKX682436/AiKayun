import { createServer, type Server } from 'node:net'
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { captureFixtureVolume } from '../src/backup/volume-archive.js'
import { DockerPgQuiesceAdapter, type DockerPgFenceConfiguration } from '../src/backup/docker-pg-fence.js'
import { capturePostgresDump, verifyPostgresDump, type PostgresDumpTarget } from '../src/backup/pg-dump.js'

let root: string
let server: Server
let input: PostgresDumpTarget
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'aikayun-dump-binary-')))
  const stagingDirectory = join(root, 'stage'), dockerBinary = join(root, 'docker'), dockerSocket = join(root, 'socket')
  await mkdir(stagingDirectory, { mode: 0o700 })
  await writeFile(dockerBinary, `#!/bin/sh\ntouch '${root}/executed'\n`, { mode: 0o700 })
  server = createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(dockerSocket, resolve) })
  input = { dockerBinary, dockerSocket, stagingDirectory, containerId: 'a'.repeat(64), database: 'fixture', user: 'fixture', assertSecureStaging: async () => {} }
})
afterEach(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  if (root) await rm(root, { recursive: true, force: true })
})
describe('dump executable trust boundary', () => {
  it('rejects a group-writable Docker binary before running it', async () => {
    await chmod(input.dockerBinary, 0o720)
    await expect(capturePostgresDump(input)).rejects.toThrow('DUMP_PATH_INVALID')
    await expect(readFile(join(root, 'executed'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(input.stagingDirectory, 'database.dump'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('rejects a binary in an untrusted writable ancestor before running it', async () => {
    const unsafe = join(root, 'unsafe')
    await mkdir(unsafe, { mode: 0o700 })
    const binary = join(unsafe, 'docker')
    await writeFile(binary, `#!/bin/sh\ntouch '${root}/executed'\n`, { mode: 0o700 })
    await chmod(unsafe, 0o777)
    await expect(capturePostgresDump({ ...input, dockerBinary: binary })).rejects.toThrow('RESTIC_ANCESTOR_UNSAFE')
    await expect(readFile(join(root, 'executed'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('also rejects writable Docker binary ancestors for volume capture and writer fencing', async () => {
    const unsafe = join(root, 'unsafe')
    await mkdir(unsafe, { mode: 0o700 })
    const binary = join(unsafe, 'docker')
    await writeFile(binary, `#!/bin/sh\ntouch '${root}/executed'\n`, { mode: 0o700 })
    await chmod(unsafe, 0o777)
    await expect(captureFixtureVolume({ dockerBinary: binary, dockerSocket: input.dockerSocket, stagingDirectory: input.stagingDirectory,
      postgresImage: `docker.io/library/postgres@sha256:${'a'.repeat(64)}`, assertSecureStaging: async () => {} },
    `aikayun-75a-test-${'b'.repeat(24)}`, 'state')).rejects.toThrow('RESTIC_ANCESTOR_UNSAFE')
    const fence = new DockerPgQuiesceAdapter({ dockerBinary: binary, dockerSocket: input.dockerSocket, dockerHome: root,
      project: 'fixture', deployment: 'c'.repeat(64), stateVolumes: ['one', 'two', 'three'],
      managed: [{ id: 'a'.repeat(64), service: 'api' }], db: {} as DockerPgFenceConfiguration['db'],
      host: { assertOwnedLock: async () => {}, verifyDeployment: async () => {} } })
    await expect(fence.assertDeployment('c'.repeat(64))).rejects.toThrow('RESTIC_ANCESTOR_UNSAFE')
    await expect(readFile(join(root, 'executed'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('rejects hard-linked and non-executable binaries before running them', async () => {
    await link(input.dockerBinary, join(root, 'other-link'))
    await expect(verifyPostgresDump(input)).rejects.toThrow('DUMP_PATH_INVALID')
    await rm(join(root, 'other-link'))
    await chmod(input.dockerBinary, 0o600)
    await expect(verifyPostgresDump(input)).rejects.toThrow('DUMP_PATH_INVALID')
    await expect(readFile(join(root, 'executed'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
