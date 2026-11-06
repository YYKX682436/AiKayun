// Linux-only synthetic fixture. The image, signatures and trust callbacks in
// this test are not production authenticity evidence.
import { createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chown, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { captureFixtureProductionOwnedDeploymentArchive } from '../../src/backup/deployment-archive.js'

if (process.env.NODE_ENV !== 'test' || process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('fixture only')
const root = await mkdtemp('/fixture-work/aikayun-deployment-metadata-')
const deploy = join(root, 'deployment'), stage = join(root, 'stage'), extracted = join(root, 'extracted')
const artifacts = ['compose.yaml', 'install.sh', 'migration-checksums.json', 'license-trust-bundle.jws', 'release-index.json',
  'release-signing-root.jwk.json', 'release-verifier.mjs', 'verify-artifacts.mjs', 'deploy/Caddyfile', 'sparse.bin']
const secrets = ['api_database_password', 'code_pool_encryption_key_ring', 'migrator_database_password', 'payment_credential_key_ring', 'postgres_admin_password']
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
try {
  await mkdir(join(deploy, 'release', 'deploy'), { recursive: true, mode: 0o700 })
  await mkdir(join(deploy, 'secrets'), { mode: 0o700 })
  await mkdir(stage, { mode: 0o700 }); await mkdir(extracted, { mode: 0o700 })
  for (const name of artifacts.filter(name => name !== 'sparse.bin')) await writeFile(join(deploy, 'release', name), `fixture ${name}`, { mode: 0o600 })
  const prepare = `import os,struct,sys
root=sys.argv[1]; p=root+'/release/compose.yaml'
os.setxattr(p,'user.backup_test',b'fixture')
acl=struct.pack('<I',2)+b''.join(struct.pack('<HHI',*x) for x in [(1,6,0xffffffff),(2,4,1001),(4,0,0xffffffff),(16,4,0xffffffff),(32,0,0xffffffff)])
os.setxattr(p,'system.posix_acl_access',acl)
os.utime(p,(1600000000,1600000000))
with open(root+'/release/sparse.bin','wb') as f: f.seek(1048576); f.write(b'x')
os.chmod(root+'/release/sparse.bin',0o600)
`
  execFileSync('/usr/bin/python3', ['-c', prepare, deploy])
  const entries = await Promise.all(artifacts.map(async name => {
    const bytes = await readFile(join(deploy, 'release', name))
    return { name, size: bytes.length, sha256: hash(bytes) }
  }))
  const manifest = Buffer.from(JSON.stringify({ artifacts: entries }))
  await writeFile(join(deploy, 'release', 'release-manifest.json'), manifest, { mode: 0o600 })
  for (const name of ['release-manifest.jws', 'release-manifest.cosign.bundle']) await writeFile(join(deploy, 'release', name), 'synthetic signature', { mode: 0o600 })
  for (const name of secrets) {
    const path = join(deploy, 'secrets', name)
    await writeFile(path, 'synthetic credential', { mode: 0o400 })
    const uid = name === 'postgres_admin_password' ? 0 : 1000
    await chown(path, uid, uid)
  }
  await writeFile(join(deploy, '.env'), 'FIXTURE=1\n', { mode: 0o600 })
  await writeFile(join(deploy, '.install-owner'), 'aikayun-install-v1\n', { mode: 0o600 })
  await writeFile(join(deploy, 'install-state.json'), JSON.stringify({ manifest_sha256: hash(manifest) }), { mode: 0o600 })
  await writeFile(join(deploy, 'aikayun'), 'fixture install.sh', { mode: 0o755 })
  const fixture = `aikayun-75a-test-${randomBytes(12).toString('hex')}`
  await captureFixtureProductionOwnedDeploymentArchive({ deploymentRoot: deploy, stagingDirectory: stage, tarBinary: '/usr/bin/tar',
    assertSecureStaging: async () => {}, assertTrustedDeployment: async () => {} }, fixture, true)
  if (((await lstat(join(stage, 'deployment.tar'))).mode & 0o777) !== 0o600) throw new Error('archive permissions invalid')
  execFileSync('/usr/bin/tar', ['--acls', '--xattrs', '--xattrs-include=*', '-xf', join(stage, 'deployment.tar'), '-C', extracted])
  const check = `import os,sys,base64,json,hashlib
r=sys.argv[1]; p=r+'/release/compose.yaml'; s=os.stat(p); q=os.stat(r+'/release/sparse.bin'); k=os.stat(r+'/secrets/payment_credential_key_ring')
print(json.dumps({'uid':s.st_uid,'gid':s.st_gid,'mode':s.st_mode & 0o7777,'mtime':int(s.st_mtime),'xattrs':{n:base64.b64encode(os.getxattr(p,n)).decode() for n in os.listxattr(p)},'sparse_size':q.st_size,'sparse_blocks':q.st_blocks,'sparse_sha256':hashlib.sha256(open(r+'/release/sparse.bin','rb').read()).hexdigest(),'secret_uid':k.st_uid,'secret_gid':k.st_gid,'secret_mode':k.st_mode & 0o7777},sort_keys=True))
`
  const before = JSON.parse(execFileSync('/usr/bin/python3', ['-c', check, deploy], { encoding: 'utf8' })) as Record<string, unknown>
  const after = JSON.parse(execFileSync('/usr/bin/python3', ['-c', check, extracted], { encoding: 'utf8' })) as Record<string, unknown>
  if (JSON.stringify(before) !== JSON.stringify(after) || Number(before.sparse_blocks) * 512 >= Number(before.sparse_size) ||
      !Object.hasOwn(before.xattrs as object, 'system.posix_acl_access') || !Object.hasOwn(before.xattrs as object, 'user.backup_test')) throw new Error('metadata mismatch')
  process.stdout.write('Synthetic deployment GNU tar metadata roundtrip passed\n')
} finally { await rm(root, { recursive: true, force: true }) }
