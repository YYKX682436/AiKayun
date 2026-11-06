import { randomUUID, createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { ResticCommandContainer } from '../src/backup/restic-command-container.js'
import { LocalResticRepository } from '../src/backup/restic-local.js'

const exec = promisify(execFile)
const image = process.env.AIKAYUN_FIXTURE_RESTIC_IMAGE ?? ''
const socket = process.env.AIKAYUN_FIXTURE_DOCKER_SOCKET ?? ''
const usable = /^sha256:[a-f0-9]{64}$/.test(image) && socket.startsWith('/')
let tempRoot = ''
let testVolume = ''
let testProject = ''
let dockerBinary = ''

afterAll(async () => {
  if (dockerBinary && testVolume && testProject) {
    const owner = await exec(dockerBinary, ['--host', `unix://${socket}`, 'volume', 'inspect', '--format',
      '{{ index .Labels "com.aikayun.fixture" }}', testVolume], { encoding: 'utf8' }).then(result => result.stdout.trim()).catch(() => '')
    if (owner === testProject) await exec(dockerBinary, ['--host', `unix://${socket}`, 'volume', 'rm', testVolume], { encoding: 'utf8' }).catch(() => {})
  }
  if (tempRoot && /^\/(?:private\/)?tmp\/aikayun-restic-command-[A-Za-z0-9]+$/.test(tempRoot)) {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

describe.skipIf(!usable)('real Restic repository command container', () => {
  it('initializes, snapshots and streams verified repository data through the signed image', async () => {
    const id = randomUUID()
    tempRoot = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'aikayun-restic-command-')))
    const repositoryDirectory = join(tempRoot, 'repository')
    const sourceDirectory = join(tempRoot, 'manifest')
    const passwordFile = join(tempRoot, 'password')
    testProject = `aikayun-75a-test-${id.replaceAll('-', '').slice(0, 24)}`
    testVolume = `${testProject}_restic_manifest`
    await Promise.all([repositoryDirectory, sourceDirectory].map(async path => {
      await mkdir(path, { mode: 0o700 })
      await chmod(path, 0o700)
    }))
    await writeFile(passwordFile, `isolated Restic command ${id}\n`, { mode: 0o600 })
    await chmod(passwordFile, 0o600)
    const document = Buffer.from(JSON.stringify({ schema: 1, id }) + '\n')
    const manifestPath = join(sourceDirectory, 'manifest.json')
    await writeFile(manifestPath, document, { mode: 0o600 })
    await chmod(manifestPath, 0o600)
    dockerBinary = join(tempRoot, 'docker-client')
    await copyFile(await exec('which', ['docker']).then(result => realpath(result.stdout.trim())), dockerBinary)
    await chmod(dockerBinary, 0o700)
    const docker = (args: string[]) => exec(dockerBinary, ['--host', `unix://${socket}`, ...args], {
      env: { PATH: '/usr/bin:/bin', HOME: tempRoot, LANG: 'C' }, timeout: 120_000, maxBuffer: 1024 * 1024,
    }).then(result => result.stdout.trim())
    await docker(['volume', 'create', '--label', `com.aikayun.fixture=${testProject}`,
      '--label', 'com.aikayun.backup.test-source=manifest', testVolume])
    await docker(['run', '--rm', '--platform', 'linux/arm64', '--network', 'none', '--mount',
      `type=volume,source=${testVolume},target=/manifest`, '--entrypoint', '/usr/local/bin/node',
      'node:24.22.0-trixie-slim@sha256:a6155384446670e9719bdc4fd0ebe4d4b29fb32a8d6aa523da3547a6cfbcf22c',
      '-e', 'const fs=require("node:fs");fs.mkdirSync("/manifest",{recursive:true,mode:0o700});fs.writeFileSync("/manifest/manifest.json",process.argv[1],{mode:0o600})',
      document.toString('utf8')])
    const assertLock = async () => {}
    const executor = new ResticCommandContainer({ dockerBinary, dockerSocket: socket, image, repositoryDirectory, passwordFile,
      testSourceVolume: testVolume, assertLock })
    await executor.initialize()
    const repository = new LocalResticRepository({ repository: repositoryDirectory, passwordFile, executor })

    await repository.initialize()
    const repositoryId = await repository.repositoryIdentity()
    expect(repositoryId).toMatch(/^[a-f0-9]{64}$/)
    const snapshotId = await repository.backupRole(sourceDirectory, id, 'manifest')
    await repository.check()
    expect(await repository.snapshotsForRole(id, 'manifest')).toEqual([snapshotId])
    const snapshot = await repository.snapshotMetadata(id) as Array<{ id?: unknown; paths?: unknown; tags?: unknown }>
    expect(snapshot).toHaveLength(1)
    expect(snapshot[0]).toMatchObject({ id: snapshotId, paths: [sourceDirectory], tags: expect.arrayContaining([`aikayun-set-${id}`, 'aikayun-role-manifest']) })
    const entries = (await repository.listSnapshot(snapshotId, manifestPath)).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
    expect(entries.at(-1)).toMatchObject({ struct_type: 'node', path: manifestPath, type: 'file', mode: 0o600 })
    const hash = await repository.hashSnapshotFile(snapshotId, manifestPath, 65536)
    expect(hash).toEqual({ size: document.length, sha256: createHash('sha256').update(document).digest('hex') })
    const extracted = join(tempRoot, 'manifest.dump')
    const output = await open(extracted, 'wx', 0o600)
    try {
      await repository.dumpFile(snapshotId, manifestPath, output, document.length)
      await output.sync()
    } finally { await output.close() }
    const read = await open(extracted, 'r')
    try {
      const actual = Buffer.alloc(document.length)
      await read.read(actual, 0, actual.length, 0)
      expect(actual).toEqual(document)
    } finally { await read.close() }
  }, 240_000)
})
