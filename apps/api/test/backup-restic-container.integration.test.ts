import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { DirectResticVolumeReader } from '../src/backup/restic-container.js'

const exec = promisify(execFile)
const image = process.env.AIKAYUN_FIXTURE_RESTIC_IMAGE
const metadataImage = process.env.AIKAYUN_FIXTURE_METADATA_IMAGE ?? 'python:3.13-alpine'
const project = process.env.AIKAYUN_FIXTURE_PROJECT ?? ''
const work = process.env.AIKAYUN_FIXTURE_WORK ?? ''
const socket = process.env.AIKAYUN_FIXTURE_DOCKER_SOCKET ?? ''
const sourceVolumes = {
  state: process.env.AIKAYUN_FIXTURE_STATE_VOLUME ?? '',
  caddyData: process.env.AIKAYUN_FIXTURE_CADDY_DATA_VOLUME ?? '',
  caddyConfig: process.env.AIKAYUN_FIXTURE_CADDY_CONFIG_VOLUME ?? '',
}
const dockerBinaryPromise = exec('which', ['docker']).then(async result => realpath(result.stdout.trim()))
const pythonScript = String.raw`
import hashlib, json, os, struct, sys
mode, root = sys.argv[1], sys.argv[2]
name = os.path.basename(root)
data = b'aiKayun Restic metadata fixture\n'
expected_acl = struct.pack('<I', 2) + b''.join([
    struct.pack('<HHI', 0x01, 0x06, 0xffffffff),
    struct.pack('<HHI', 0x02, 0x04, 2345),
    struct.pack('<HHI', 0x04, 0x04, 0xffffffff),
    struct.pack('<HHI', 0x10, 0x04, 0xffffffff),
    struct.pack('<HHI', 0x20, 0x00, 0xffffffff),
])
if mode == 'prepare':
    os.makedirs(root, mode=0o700, exist_ok=False)
    path = os.path.join(root, 'mode-xattr-acl.bin')
    with open(path, 'wb') as file: file.write(data)
    os.chown(path, 1234, 2345)
    os.chmod(path, 0o640)
    os.setxattr(path, 'user.aikayun.fixture', b'xattr-preserved')
    os.setxattr(path, 'system.posix_acl_access', expected_acl)
    os.link(path, os.path.join(root, 'hardlink.bin'))
    os.symlink('mode-xattr-acl.bin', os.path.join(root, 'symlink.bin'))
    sparse = os.path.join(root, 'sparse.bin')
    with open(sparse, 'wb') as file:
        file.truncate(64 * 1024 * 1024)
        file.seek(64 * 1024 * 1024 - 1)
        file.write(b'Z')
    sparse_stat = os.stat(sparse)
    os.chmod(root, 0o700)
    print(json.dumps({'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data), 'acl_bytes': len(expected_acl),
        'sparse_logical_bytes': sparse_stat.st_size, 'sparse_allocated_512b_blocks': sparse_stat.st_blocks}))
elif mode == 'verify':
    path = os.path.join(root, 'mode-xattr-acl.bin')
    link = os.path.join(root, 'hardlink.bin')
    stat = os.stat(path)
    assert stat.st_uid == 1234 and stat.st_gid == 2345 and stat.st_mode & 0o777 == 0o640
    assert hashlib.sha256(open(path, 'rb').read()).hexdigest() == hashlib.sha256(data).hexdigest()
    assert os.getxattr(path, 'user.aikayun.fixture') == b'xattr-preserved'
    assert os.getxattr(path, 'system.posix_acl_access') == expected_acl
    assert os.stat(link).st_ino == stat.st_ino and os.stat(link).st_dev == stat.st_dev
    assert os.readlink(os.path.join(root, 'symlink.bin')) == 'mode-xattr-acl.bin'
    sparse = os.stat(os.path.join(root, 'sparse.bin'))
    assert sparse.st_size == 64 * 1024 * 1024
    with open(os.path.join(root, 'sparse.bin'), 'rb') as file:
        assert file.read(1) == b'\0'
        file.seek(64 * 1024 * 1024 - 1)
        assert file.read(1) == b'Z'
    print(json.dumps({'uid': stat.st_uid, 'gid': stat.st_gid, 'mode': stat.st_mode & 0o777,
        'sha256': hashlib.sha256(open(path, 'rb').read()).hexdigest(), 'xattr': 'preserved', 'acl': 'preserved',
        'hardlink': 'preserved', 'symlink': 'preserved', 'sparse_logical_bytes': sparse.st_size,
        'sparse_allocated_512b_blocks': sparse.st_blocks}))
else:
    raise SystemExit(2)
`

async function docker(args: string[], timeout = 120_000): Promise<string> {
  if (!socket.startsWith('/')) throw new Error('RESTIC_READER_FIXTURE_SOCKET_INVALID')
  const binary = await dockerBinaryPromise
  return (await exec(binary, ['--host', `unix://${socket}`, ...args], {
    env: { PATH: '/usr/bin:/bin', HOME: work, LANG: 'C' }, timeout, maxBuffer: 2 * 1024 * 1024,
  })).stdout.trim()
}

function safeDockerError(error: unknown): string {
  const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : ''
  const text = stderr.toLowerCase()
  const allowed = new Set('fatal error failed unable to open read write create find restore backup snapshot repository config password invalid source no such file directory already locked permission denied operation not permitted space full lock stat lstat mkdir save load path cannot could does exist found parent data cache metadata pack readable blocked read only stale bad descriptor checksum unsupported chown'.split(' '))
  const tokens = (stderr.toLowerCase().match(/[a-z]+/g) ?? []).filter(token => allowed.has(token))
  const operation = ['lchown', 'chown', 'setxattr', 'lsetxattr', 'chmod', 'lchmod', 'symlink', 'hardlink', 'mkdir', 'rename', 'open', 'write']
    .find(token => text.includes(token)) ?? 'unknown-operation'
  return [operation, ...new Set([...tokens.slice(0, 8), ...tokens.slice(-10)])].join('-')
}

const usable = Boolean(image && /^sha256:[a-f0-9]{64}$/.test(image) &&
  /^aikayun-75a-test-[a-f0-9]{24}$/.test(project) && work && socket &&
  sourceVolumes.state === `${project}_aikayun_state` && sourceVolumes.caddyData === `${project}_caddy_data` &&
  sourceVolumes.caddyConfig === `${project}_caddy_config`)
let restoreVolume = ''
let stagingVolume = ''
let deploymentVolume = ''
let tempRoot = ''

afterAll(async () => {
  const restoreContainer = `${project}-reader-restore`
  if (/^aikayun-75a-test-[a-f0-9]{24}-reader-restore$/.test(restoreContainer)) {
    const owner = await docker(['inspect', '--format', '{{ index .Config.Labels "com.aikayun.fixture" }}', restoreContainer]).catch(() => '')
    if (owner === project) {
      await docker(['stop', '--timeout', '2', restoreContainer]).catch(() => {})
      await docker(['rm', restoreContainer]).catch(() => {})
    }
  }
  for (const volume of [restoreVolume, stagingVolume, deploymentVolume]) {
    if (!volume || !/^aikayun-75a-test-[a-f0-9]{24}_reader_(?:restore_[a-f0-9]{32}|staging|deployment)$/.test(volume)) continue
    const owner = await docker(['volume', 'inspect', '--format', '{{ index .Labels "com.aikayun.fixture" }}', volume]).catch(() => '')
    if (owner === project) await docker(['volume', 'rm', volume]).catch(() => {})
  }
  if (tempRoot && tempRoot.startsWith(`${process.cwd()}/.tmp-restic-reader-`)) {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

describe.skipIf(!usable)('real release Compose Restic volume reader', () => {
  it('captures and restores Compose volumes with Linux metadata through read-only sources', async () => {
    process.env.NODE_ENV = 'test'
    const running = new Map<string, boolean>()
    const stopped: string[] = []
    const serviceIds = new Map<string, string>()
    for (const service of ['api', 'web', 'caddy']) {
      const id = await docker(['ps', '-aq', '--no-trunc', '--filter', `label=com.docker.compose.project=${project}`, '--filter', `label=com.docker.compose.service=${service}`])
      if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('RESTIC_READER_FIXTURE_SERVICE_INVALID')
      const state = await docker(['inspect', '--format', '{{.State.Status}}', id])
      running.set(id, state === 'running')
      serviceIds.set(service, id)
      if (state === 'running') stopped.push(id)
    }
    const id = randomUUID()
    tempRoot = await realpath(await mkdtemp(join(process.cwd(), '.tmp-restic-reader-')))
    const repositoryDirectory = join(tempRoot, 'repository')
    const deploymentRoot = join(tempRoot, 'deployment')
    const stagingDirectory = join(tempRoot, 'staging', `set-${id}`)
    const passwordFile = join(tempRoot, 'password')
    const dockerClient = join(tempRoot, 'docker-client')
    restoreVolume = `${project}_reader_restore_${id.replaceAll('-', '')}`
    stagingVolume = `${project}_reader_staging`
    deploymentVolume = `${project}_reader_deployment`
    await mkdir(repositoryDirectory, { mode: 0o700 })
    await mkdir(deploymentRoot, { mode: 0o700 })
    await mkdir(join(stagingDirectory, 'payload'), { recursive: true, mode: 0o700 })
    await Promise.all([repositoryDirectory, deploymentRoot, stagingDirectory, join(stagingDirectory, 'payload')].map(path => chmod(path, 0o700)))
    await writeFile(join(deploymentRoot, 'compose.yaml'), 'services: { api: { image: "fixture" } }\n', { mode: 0o600 })
    await writeFile(join(stagingDirectory, 'payload', 'fixture.txt'), 'staging payload\n', { mode: 0o600 })
    await writeFile(passwordFile, `isolated test password ${id}\n`, { mode: 0o600 })
    await copyFile(await dockerBinaryPromise, dockerClient)
    await chmod(dockerClient, 0o700)
    const helper = join(tempRoot, 'metadata.py')
    await writeFile(helper, pythonScript, { mode: 0o600 })

    try {
      if (stopped.length) await docker(['stop', ...stopped])
      const metadataPath = `/var/lib/aikayun/.backup-reader-${id}`
      const prepared = JSON.parse(await docker(['run', '--rm', '--pull=never', '--network', 'none', '--mount', `type=volume,source=${sourceVolumes.state},target=/state`,
        '--mount', `type=bind,source=${helper},target=/metadata.py,readonly`, '--entrypoint', 'python3', metadataImage,
        '/metadata.py', 'prepare', `/state${metadataPath}`])) as Record<string, unknown>
      const fixtureOwner = await docker(['volume', 'inspect', '--format', '{{ index .Labels "com.aikayun.fixture" }}', sourceVolumes.state])
      if (fixtureOwner !== project) throw new Error('RESTIC_READER_FIXTURE_VOLUME_OWNERSHIP_INVALID')
      for (const [volume, label] of [[stagingVolume, 'backup_staging'], [deploymentVolume, 'backup_deployment']] as const) {
        await docker(['volume', 'create', '--label', `com.aikayun.fixture=${project}`, '--label', `com.docker.compose.volume=${label}`,
          '--label', 'com.docker.compose.project=aikayun', volume])
      }
      await docker(['run', '--rm', '--pull=never', '--network', 'none', '--mount', `type=volume,source=${stagingVolume},target=/staging`,
        '--entrypoint', '/bin/sh', 'alpine:3.24.1', '-c', 'mkdir -m 700 /staging/payload && printf "staging payload\\n" > /staging/payload/fixture.txt && chmod 600 /staging/payload/fixture.txt'])
      await docker(['run', '--rm', '--pull=never', '--network', 'none', '--mount', `type=volume,source=${deploymentVolume},target=/deployment`,
        '--entrypoint', '/bin/sh', 'alpine:3.24.1', '-c', 'printf "services: { api: { image: \\"fixture\\" } }\\n" > /deployment/compose.yaml && chmod 600 /deployment/compose.yaml'])
      await docker(['volume', 'create', '--label', `com.aikayun.fixture=${project}`, restoreVolume])
      const repoInit = ['run', '--rm', '--pull=never', '--network', 'none', '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m',
        '--cap-drop', 'ALL', '--cap-add', 'DAC_READ_SEARCH', '--security-opt', 'no-new-privileges:true', '--user', '0:0',
        '--mount', `type=bind,source=${repositoryDirectory},target=/repo`, '--mount', `type=bind,source=${passwordFile},target=/run/password,readonly`,
        '--entrypoint', '/usr/bin/restic', image!, '--repo', '/repo', '--password-file', '/run/password', '--no-cache', 'init', '--repository-version', '2']
      await docker(repoInit)
      let diagnostic = ''
      const reader = await DirectResticVolumeReader.create({ dockerBinary: dockerClient, dockerSocket: socket, image: image!,
        repositoryDirectory, passwordFile, stagingDirectory, deploymentRoot, backupSetId: id,
        testSourceVolumes: sourceVolumes, testStagingVolume: stagingVolume, testDeploymentVolume: deploymentVolume,
        timeoutMs: 120_000, assertLock: async () => {}, testDiagnostic: tokens => { diagnostic = tokens } })
      const snapshot = await reader.backup().catch(error => {
        throw new Error(`${error instanceof Error ? error.message : 'RESTIC_READER_FAILED'}:${diagnostic || 'no-diagnostic'}`)
      })
      expect(snapshot.snapshotId).toMatch(/^[a-f0-9]{64}$/)
      const snapshotList = JSON.parse(await docker(['run', '--rm', '--pull=never', '--network', 'none', '--read-only',
        '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m', '--mount', `type=bind,source=${repositoryDirectory},target=/repo`,
        '--mount', `type=bind,source=${passwordFile},target=/run/password,readonly`, '--entrypoint', '/usr/bin/restic', image!,
        '--repo', '/repo', '--password-file', '/run/password', '--no-cache', 'snapshots', '--json', '--tag', `aikayun-set-${id}`])) as Array<{ id?: unknown; tags?: unknown; paths?: unknown }>
      expect(snapshotList).toHaveLength(1)
      expect(snapshotList[0]).toMatchObject({ id: snapshot.snapshotId })
      expect(snapshotList[0]?.tags).toEqual(expect.arrayContaining([`aikayun-set-${id}`, 'aikayun-role-source']))
      expect(snapshotList[0]?.paths).toEqual(expect.arrayContaining(['/sources/state', '/sources/caddy-data', '/sources/caddy-config',
        '/sources/deployment', '/sources/staging/payload']))
      const restore = ['run', '--rm', '--pull=never', '--network', 'none', '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m',
        '--cap-drop', 'ALL', '--cap-add', 'DAC_READ_SEARCH', '--cap-add', 'CHOWN', '--cap-add', 'FOWNER', '--cap-add', 'DAC_OVERRIDE',
        '--security-opt', 'no-new-privileges:true', '--user', '0:0',
        '--name', `${project}-reader-restore`, '--label', `com.aikayun.fixture=${project}`,
        '--mount', `type=bind,source=${repositoryDirectory},target=/repo`, '--mount', `type=bind,source=${passwordFile},target=/run/password,readonly`,
        '--mount', `type=volume,source=${restoreVolume},target=/restore`, '--entrypoint', '/usr/bin/restic', image!,
        '--repo', '/repo', '--password-file', '/run/password', '--no-cache', 'restore', snapshot.snapshotId, '--target', '/restore']
      await docker(restore, 240_000).catch(error => { throw new Error(`RESTIC_READER_RESTORE_FAILED:${safeDockerError(error)}`) })
      await docker(['run', '--rm', '--pull=never', '--network', 'none', '--mount', `type=volume,source=${restoreVolume},target=/restore,readonly`,
        '--entrypoint', '/bin/sh', 'alpine:3.24.1', '-c', 'test -s /restore/sources/deployment/compose.yaml && test "$(cat /restore/sources/staging/payload/fixture.txt)" = "staging payload"'])
      const metadataResult = await docker(['run', '--rm', '--pull=never', '--network', 'none', '--mount', `type=volume,source=${restoreVolume},target=/restore,readonly`,
        '--mount', `type=bind,source=${helper},target=/metadata.py,readonly`, '--entrypoint', 'python3', metadataImage,
        '/metadata.py', 'verify', `/restore/sources/state${metadataPath}`]).catch(error => {
          throw new Error(`RESTIC_READER_METADATA_VERIFY_FAILED:${safeDockerError(error)}`)
        })
      const metadata = JSON.parse(metadataResult) as Record<string, unknown>
      expect(metadata).toMatchObject({ uid: 1234, gid: 2345, mode: 0o640, xattr: 'preserved', acl: 'preserved',
        hardlink: 'preserved', symlink: 'preserved', sparse_logical_bytes: 64 * 1024 * 1024 })
      expect(Number.isSafeInteger(metadata.sparse_allocated_512b_blocks)).toBe(true)
      expect(prepared.sparse_logical_bytes).toBe(metadata.sparse_logical_bytes)
      expect(Number.isSafeInteger(prepared.sparse_allocated_512b_blocks)).toBe(true)
      console.info('Restic metadata restore verified:', JSON.stringify({ uid: metadata.uid, gid: metadata.gid, mode: metadata.mode,
        xattr: metadata.xattr, acl: metadata.acl, hardlink: metadata.hardlink, symlink: metadata.symlink,
        sparse_logical_bytes: metadata.sparse_logical_bytes, source_sparse_allocated_512b_blocks: prepared.sparse_allocated_512b_blocks,
        restored_sparse_allocated_512b_blocks: metadata.sparse_allocated_512b_blocks }))
      await docker(['start', ...stopped])
      stopped.length = 0
      for (const [service, containerId] of serviceIds) {
        if (running.get(containerId) && await docker(['inspect', '--format', '{{.State.Status}}', containerId]) !== 'running') {
          throw new Error(`RESTIC_READER_FIXTURE_SERVICE_NOT_RESTORED_${service.toUpperCase()}`)
        }
      }
    } finally {
      if (stopped.length) await docker(['start', ...stopped]).catch(() => {})
    }
  }, 300_000)
})
