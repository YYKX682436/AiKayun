import { createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstat, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { captureFixtureVolume, captureFixtureVolumeWithMetadata, type VolumeArchiveTarget } from '../src/backup/volume-archive.js'
import { verifyStateArchiveProtection } from '../src/backup/state-archive-protection.js'

const enabled = process.env.AIKAYUN_TEST_LOCAL_DOCKER === 'true'
describe.skipIf(!enabled)('read-only production-layout archive using isolated Docker volumes', () => {
  let binary: string
  let socket: string
  let fixture: string
  let badFixture: string
  let root: string
  let input: VolumeArchiveTarget
  const image = 'docker.io/library/postgres@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873'
  const docker = (...args: string[]) => execFileSync(binary, ['--host', `unix://${socket}`, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  beforeAll(async () => {
    binary = await realpath(process.env.AIKAYUN_TEST_DOCKER_BINARY!)
    socket = await realpath(process.env.AIKAYUN_TEST_DOCKER_SOCKET!)
    if (!(await lstat(socket)).isSocket()) throw new Error('local Unix Docker socket required')
    fixture = `aikayun-75a-test-${randomBytes(12).toString('hex')}`
    badFixture = `aikayun-75a-test-${randomBytes(12).toString('hex')}`
    root = await realpath(await mkdtemp(join(tmpdir(), 'aikayun-75a-volume-')))
    input = { dockerBinary: binary, dockerSocket: socket, postgresImage: image, stagingDirectory: root,
      assertSecureStaging: async () => { /* Isolated synthetic fixture data only. */ } }
    docker('image', 'inspect', image)
    for (const suffix of ['aikayun_state', 'caddy_data', 'caddy_config']) {
      const volume = `${fixture}_${suffix}`
      docker('volume', 'create', '--label', `com.aikayun.fixture=${fixture}`, volume)
      docker('run', '--rm', '--pull=never', '--network', 'none', '--mount', `type=volume,source=${volume},target=/fixture`,
        '--entrypoint', 'sh', image, '-c', 'printf fixture-data > /fixture/content; printf hidden-fixture > /fixture/.hidden')
    }
    docker('run', '--rm', '--pull=never', '--network', 'none', '--user', '0:0', '--mount', `type=volume,source=${fixture}_aikayun_state,target=/fixture`,
      '--entrypoint', 'sh', image, '-c', `mkdir -p /fixture/identity/current /fixture/license-pending /fixture/license-trust /fixture/media /fixture/private-files
for f in identity/current/identity.json identity/current/identity-intent.json identity/current/instance-private-key.pk8.pem license-pending/license-pending-aes-256-gcm.json; do printf fixture > "/fixture/$f"; chmod 600 "/fixture/$f"; done
chown -R 1234:1234 /fixture/identity /fixture/license-pending /fixture/license-trust /fixture/media /fixture/private-files
chmod 700 /fixture/identity /fixture/identity/current /fixture/license-pending /fixture/license-trust /fixture/media /fixture/private-files
printf '%s\\n' aikayun-state-volume-v1 > /fixture/.aikayun-volume-v1; chmod 400 /fixture/.aikayun-volume-v1`)
    docker('volume', 'create', '--label', 'com.aikayun.fixture=wrong', `${badFixture}_aikayun_state`)
  }, 60_000)
  afterAll(async () => {
    for (const [prefix, suffixes] of [[fixture, ['aikayun_state', 'caddy_data', 'caddy_config']], [badFixture, ['aikayun_state']]] as const) {
      if (!prefix) continue
      for (const suffix of suffixes) {
        const name = `${prefix}_${suffix}`
        try {
          const label = docker('volume', 'inspect', '--format', '{{ index .Labels "com.aikayun.fixture" }}', name)
          if (label === prefix || (prefix === badFixture && label === 'wrong')) docker('volume', 'rm', name)
        } catch { /* fixture may not have been created */ }
      }
    }
    if (root) await rm(root, { recursive: true, force: true })
  })
  it('archives only verified labelled volumes with read-only mounts, 0600 and matching hashes', async () => {
    for (const [kind, filename] of [['state', 'state.tar'], ['caddy-data', 'caddy-data.tar'], ['caddy-config', 'caddy-config.tar']] as const) {
      const result = await captureFixtureVolume(input, fixture, kind)
      const path = join(root, filename)
      const bytes = await readFile(path)
      expect(result).toEqual({ size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
      expect((await lstat(path)).mode & 0o777).toBe(0o600)
      const listing = execFileSync('tar', ['-tf', path], { encoding: 'utf8' })
      expect(listing).toContain('./content')
      expect(listing).toContain('./.hidden')
      if (kind === 'state') await verifyStateArchiveProtection(root, 1234, true)
      await expect(captureFixtureVolume(input, fixture, kind)).rejects.toMatchObject({ code: 'EEXIST' })
    }
  }, 60_000)
  it('rejects unlabelled or unexpected volumes, unsafe image and unproven staging', async () => {
    await expect(captureFixtureVolume(input, badFixture, 'state')).rejects.toThrow('ARCHIVE_VOLUME_IDENTITY_INVALID')
    await expect(captureFixtureVolume(input, 'aikayun_state', 'state')).rejects.toThrow('ARCHIVE_FIXTURE_INVALID')
    await expect(captureFixtureVolume({ ...input, postgresImage: 'postgres:latest' }, fixture, 'state')).rejects.toThrow('ARCHIVE_IMAGE_INVALID')
    await expect(captureFixtureVolume({ ...input, assertSecureStaging: async () => { throw new Error('storage unproven') } }, fixture, 'state')).rejects.toThrow('storage unproven')
  })
  it('rejects a bad state marker and a missing business directory in captured archives', async () => {
    const volume = `${fixture}_aikayun_state`
    const run = (script: string) => docker('run', '--rm', '--pull=never', '--network', 'none', '--user', '0:0',
      '--mount', `type=volume,source=${volume},target=/fixture`, '--entrypoint', 'sh', image, '-c', script)
    try {
      run('chmod 600 /fixture/.aikayun-volume-v1; printf invalid > /fixture/.aikayun-volume-v1; chmod 400 /fixture/.aikayun-volume-v1')
      const stage = await mkdtemp(join(root, 'bad-marker-'))
      await captureFixtureVolume({ ...input, stagingDirectory: stage }, fixture, 'state')
      await expect(verifyStateArchiveProtection(stage, 1234, true)).rejects.toThrow('BACKUP_STATE_PROTECTION_INVALID')
      run('chmod 600 /fixture/.aikayun-volume-v1; printf "%s\\n" aikayun-state-volume-v1 > /fixture/.aikayun-volume-v1; chmod 400 /fixture/.aikayun-volume-v1; mv /fixture/media /fixture/media-hidden')
      const missing = await mkdtemp(join(root, 'missing-media-'))
      await captureFixtureVolume({ ...input, stagingDirectory: missing }, fixture, 'state')
      await expect(verifyStateArchiveProtection(missing, 1234, true)).rejects.toThrow('BACKUP_STATE_PROTECTION_INVALID')
    } finally {
      run('chmod 600 /fixture/.aikayun-volume-v1; printf "%s\\n" aikayun-state-volume-v1 > /fixture/.aikayun-volume-v1; chmod 400 /fixture/.aikayun-volume-v1; if [ -d /fixture/media-hidden ]; then mv /fixture/media-hidden /fixture/media; fi')
    }
  }, 60_000)
  it.skipIf(!process.env.AIKAYUN_TEST_ARCHIVE_METADATA_IMAGE)('documents actual volume tar metadata roundtrip with isolated Linux files', async () => {
    const helper = process.env.AIKAYUN_TEST_ARCHIVE_METADATA_IMAGE!
    const volume = `${fixture}_aikayun_state`
    // Synthetic files only; the extended ACL has a named reader and a mask.
    const seed = `import os,struct
p='/fixture/metadata'
open(p,'wb').write(b'metadata fixture')
os.chown(p,1234,2345)
os.chmod(p,0o640)
os.utime(p,(1600000000,1600000000))
os.setxattr(p,'user.backup_test',b'fixture')
acl=struct.pack('<I',2)+b''.join(struct.pack('<HHI',*x) for x in [(1,6,0xffffffff),(2,4,1001),(4,0,0xffffffff),(16,4,0xffffffff),(32,0,0xffffffff)])
os.setxattr(p,'system.posix_acl_access',acl)
os.link(p,'/fixture/hardlink')
os.symlink('metadata','/fixture/symlink')
with open('/fixture/sparse','wb') as f: f.seek(1048576); f.write(b'x')
`
    docker('run', '--rm', '--pull=never', '--network', 'none', '--user', '0:0', '--mount', `type=volume,source=${volume},target=/fixture`,
      '--entrypoint', 'python3', helper, '-c', seed)
    const stage = await mkdtemp(join(root, 'metadata-'))
    await captureFixtureVolume({ ...input, stagingDirectory: stage }, fixture, 'state')
    const archive = await readFile(join(stage, 'state.tar'))
    const check = `import os,json,base64,hashlib
p='/extracted/metadata'; s=os.stat(p); h=os.stat('/extracted/hardlink'); sparse=os.stat('/extracted/sparse')
print(json.dumps({'uid':s.st_uid,'gid':s.st_gid,'mode':s.st_mode & 0o7777,'mtime':int(s.st_mtime),'hardlink':s.st_ino==h.st_ino,'symlink':os.readlink('/extracted/symlink'),'content':open(p,'rb').read().decode(),'xattrs':os.listxattr(p),'xattr_values':{n:base64.b64encode(os.getxattr(p,n)).decode() for n in os.listxattr(p)},'sparse_size':sparse.st_size,'sparse_blocks':sparse.st_blocks,'sparse_sha256':hashlib.sha256(open('/extracted/sparse','rb').read()).hexdigest()}))
`
    type Metadata = { uid: number; gid: number; mode: number; mtime: number; hardlink: boolean; symlink: string; content: string; xattrs: string[]; xattr_values: Record<string, string>; sparse_size: number; sparse_blocks: number; sparse_sha256: string }
    const source = JSON.parse(docker('run', '--rm', '--pull=never', '--network', 'none', '--user', '0:0',
      '--mount', `type=volume,source=${volume},target=/fixture,readonly`, '--entrypoint', 'python3', helper, '-c', check.replaceAll('/extracted/', '/fixture/'))) as Metadata
    const output = execFileSync(binary, ['--host', `unix://${socket}`, 'run', '--rm', '-i', '--pull=never', '--network', 'none', '--user', '0:0',
      '--entrypoint', '/bin/sh', helper, '-c', 'mkdir /extracted; tar --acls --xattrs --xattrs-include="*" -xf - -C /extracted; exec python3 -c "$1"', 'fixture', check],
    { input: archive, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    const restored = JSON.parse(output) as Metadata
    expect(source.xattrs).toContain('user.backup_test')
    expect(source.xattrs).toContain('system.posix_acl_access')
    expect(source.sparse_blocks * 512).toBeLessThan(1048577)
    expect(restored).toMatchObject({ uid: 1234, gid: 2345, mode: 0o640, mtime: 1600000000,
      hardlink: true, symlink: 'metadata', content: 'metadata fixture', sparse_size: 1048577 })
    // The actual BusyBox tar -cf does not encode these Linux extensions; the
    // extractor's GNU flags cannot restore metadata absent from the archive.
    expect(restored.xattrs).not.toContain('user.backup_test')
    expect(restored.xattrs).not.toContain('system.posix_acl_access')
    expect(restored.sparse_blocks * 512).toBeGreaterThanOrEqual(1048577)
    const helperId = docker('image', 'inspect', '--format', '{{.Id}}', helper)
    const candidateStage = await mkdtemp(join(root, 'metadata-candidate-'))
    await expect(captureFixtureVolumeWithMetadata({ ...input, stagingDirectory: candidateStage }, fixture, 'state', helper)).rejects.toThrow('ARCHIVE_FIXTURE_INVALID')
    await captureFixtureVolumeWithMetadata({ ...input, stagingDirectory: candidateStage }, fixture, 'state', helperId)
    await verifyStateArchiveProtection(candidateStage, 1234, true)
    const candidate = await readFile(join(candidateStage, 'state.tar'))
    const candidateOutput = execFileSync(binary, ['--host', `unix://${socket}`, 'run', '--rm', '-i', '--pull=never', '--network', 'none', '--user', '0:0',
      '--entrypoint', '/bin/sh', helperId, '-c', 'mkdir /extracted; tar --acls --xattrs --xattrs-include="*" -xf - -C /extracted; exec python3 -c "$1"', 'fixture', check],
    { input: candidate, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    const candidateRestored = JSON.parse(candidateOutput) as Metadata
    expect(candidateRestored).toMatchObject({ uid: 1234, gid: 2345, mode: 0o640, mtime: 1600000000,
      hardlink: true, symlink: 'metadata', content: 'metadata fixture', sparse_size: 1048577 })
    expect(candidateRestored.xattrs).toContain('user.backup_test')
    expect(candidateRestored.xattrs).toContain('system.posix_acl_access')
    expect(candidateRestored.xattr_values).toEqual(source.xattr_values)
    expect(candidateRestored.sparse_sha256).toBe(source.sparse_sha256)
    expect(candidateRestored.sparse_blocks * 512).toBeLessThan(1048577)
    for (const kind of ['caddy-data', 'caddy-config'] as const) {
      const caddyStage = await mkdtemp(join(root, 'metadata-caddy-'))
      const result = await captureFixtureVolumeWithMetadata({ ...input, stagingDirectory: caddyStage }, fixture, kind, helperId)
      expect(result.size).toBeGreaterThan(1024)
    }
  }, 60_000)
})
