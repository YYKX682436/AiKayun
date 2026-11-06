import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { captureDeploymentArchive, captureFixtureDeploymentArchive, type DeploymentArchiveTarget } from '../src/backup/deployment-archive.js'

const artifactNames = ['compose.yaml', 'install.sh', 'migration-checksums.json', 'license-trust-bundle.jws',
  'release-index.json', 'release-signing-root.jwk.json', 'release-verifier.mjs', 'verify-artifacts.mjs', 'deploy/Caddyfile']
const secretNames = ['api_database_password', 'code_pool_encryption_key_ring', 'migrator_database_password',
  'payment_credential_key_ring', 'postgres_admin_password']
const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')
let root: string
let deploy: string
let stage: string
let input: DeploymentArchiveTarget
let trustedChecks: number
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'aikayun-75a-deployment-')))
  deploy = join(root, 'deployment')
  stage = join(root, 'stage')
  await mkdir(deploy, { mode: 0o700 }); await mkdir(stage, { mode: 0o700 })
  await mkdir(join(deploy, 'release', 'deploy'), { recursive: true, mode: 0o700 })
  await mkdir(join(deploy, 'secrets'), { mode: 0o700 })
  const artifacts = []
  for (const name of artifactNames) {
    const content = Buffer.from(`signed fixture ${name}`)
    await writeFile(join(deploy, 'release', name), content, { mode: 0o600 })
    artifacts.push({ name, size: content.length, sha256: sha(content) })
  }
  const manifest = Buffer.from(JSON.stringify({ artifacts }))
  await writeFile(join(deploy, 'release', 'release-manifest.json'), manifest, { mode: 0o600 })
  for (const name of ['release-manifest.jws', 'release-manifest.cosign.bundle']) await writeFile(join(deploy, 'release', name), 'signature-fixture', { mode: 0o600 })
  for (const name of secretNames) await writeFile(join(deploy, 'secrets', name), `secret-fixture-${name}`, { mode: 0o600 })
  await writeFile(join(deploy, '.env'), 'CONFIG=fixture\n', { mode: 0o600 })
  await writeFile(join(deploy, '.install-owner'), 'aikayun-install-v1\n', { mode: 0o600 })
  await writeFile(join(deploy, 'install-state.json'), JSON.stringify({ manifest_sha256: sha(manifest) }), { mode: 0o600 })
  await writeFile(join(deploy, 'aikayun'), 'signed fixture install.sh', { mode: 0o755 })
  trustedChecks = 0
  input = { deploymentRoot: deploy, stagingDirectory: stage, tarBinary: await realpath('/usr/bin/tar'),
    assertTrustedDeployment: async () => { trustedChecks++ }, assertSecureStaging: async () => {} }
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('deployment archive with synthetic credentials', () => {
  it('includes deployment, signature files and every secret; returns only hash and length', async () => {
    const result = await captureFixtureDeploymentArchive(input, `aikayun-75a-test-${'a'.repeat(24)}`)
    const path = join(stage, 'deployment.tar')
    const bytes = await readFile(path)
    expect(result).toEqual({ size: bytes.length, sha256: sha(bytes) })
    expect(JSON.stringify(result)).not.toContain('secret-fixture')
    expect((await lstat(path)).mode & 0o777).toBe(0o600)
    expect(trustedChecks).toBe(2)
    const entries = execFileSync('/usr/bin/tar', ['-tf', path], { encoding: 'utf8' })
    for (const name of secretNames) expect(entries).toContain(`secrets/${name}`)
    expect(entries).toContain('release/release-manifest.jws')
    expect(entries).toContain('release/deploy/Caddyfile')
    expect(execFileSync('/usr/bin/tar', ['-xOf', path, 'secrets/payment_credential_key_ring'], { encoding: 'utf8' })).toBe('secret-fixture-payment_credential_key_ring')
    await expect(captureFixtureDeploymentArchive(input, `aikayun-75a-test-${'a'.repeat(24)}`)).rejects.toMatchObject({ code: 'EEXIST' })
  })
  it('rejects missing keys, changed artifacts and a mismatched manifest', async () => {
    const key = join(deploy, 'secrets', secretNames[0]!)
    await rm(key)
    await expect(captureFixtureDeploymentArchive(input, `aikayun-75a-test-${'a'.repeat(24)}`)).rejects.toThrow()
    await writeFile(key, 'secret-fixture-api_database_password', { mode: 0o600 })
    await writeFile(join(deploy, 'release', 'compose.yaml'), 'changed')
    await expect(captureFixtureDeploymentArchive(input, `aikayun-75a-test-${'a'.repeat(24)}`)).rejects.toThrow('DEPLOYMENT_MANIFEST_MISMATCH')
    expect(await readdirNames(stage)).not.toContain('deployment.tar')
  })
  it('never treats the synthetic 0600 same-UID secrets as a production deployment', async () => {
    await expect(captureDeploymentArchive(input)).rejects.toThrow('ARCHIVE_HELPER_AUTHENTICATION_UNAVAILABLE')
    expect(await readdirNames(stage)).not.toContain('deployment.tar')
  })
  it('rejects symbolic and hard links without following them', async () => {
    const path = join(deploy, 'secrets', secretNames[0]!)
    await rm(path)
    await symlink(secretNames[1]!, path)
    await expect(captureFixtureDeploymentArchive(input, `aikayun-75a-test-${'a'.repeat(24)}`)).rejects.toThrow('DEPLOYMENT_PATH_UNSAFE')
    await rm(path)
    await link(join(deploy, 'secrets', secretNames[1]!), path)
    await expect(captureFixtureDeploymentArchive(input, `aikayun-75a-test-${'a'.repeat(24)}`)).rejects.toThrow('DEPLOYMENT_PATH_UNSAFE')
  })
  it('deletes the archive if the trusted release recheck fails', async () => {
    input.assertTrustedDeployment = async () => {
      trustedChecks++
      if (trustedChecks === 2) throw new Error('release verification failed')
    }
    await expect(captureFixtureDeploymentArchive(input, `aikayun-75a-test-${'a'.repeat(24)}`)).rejects.toThrow('release verification failed')
    expect(await readdirNames(stage)).not.toContain('deployment.tar')
  })
  it('preserves the archive if trusted deployment proof remains unavailable during cleanup', async () => {
    input.assertTrustedDeployment = async () => { if (++trustedChecks >= 2) throw new Error('lock lost') }
    await expect(captureFixtureDeploymentArchive(input, `aikayun-75a-test-${'a'.repeat(24)}`)).rejects.toMatchObject({ code: 'ARCHIVE_CLEANUP_UNVERIFIED' })
    expect(await readdirNames(stage)).toContain('deployment.tar')
  })
  it('preserves the archive and reports uncertain cleanup after cancellation', async () => {
    const controller = new AbortController()
    input.signal = controller.signal
    input.assertTrustedDeployment = async () => {
      if (++trustedChecks === 2) { controller.abort(); throw new Error('cancelled') }
    }
    await expect(captureFixtureDeploymentArchive(input, `aikayun-75a-test-${'a'.repeat(24)}`)).rejects.toMatchObject({ code: 'ARCHIVE_CLEANUP_UNVERIFIED' })
    expect(await readdirNames(stage)).toContain('deployment.tar')
  })
  it('refuses to delete a replacement archive after a capture failure', async () => {
    const path = join(stage, 'deployment.tar')
    input.assertTrustedDeployment = async () => {
      if (++trustedChecks === 2) {
        await rm(path)
        await writeFile(path, 'replacement', { mode: 0o600 })
        throw new Error('recheck failed')
      }
    }
    await expect(captureFixtureDeploymentArchive(input, `aikayun-75a-test-${'a'.repeat(24)}`)).rejects.toMatchObject({ code: 'ARCHIVE_CLEANUP_UNVERIFIED' })
    expect(await readFile(path, 'utf8')).toBe('replacement')
  })
  it('detects a changed source during tar and deletes the incomplete archive', async () => {
    const wrapper = join(root, 'mutating-tar')
    await writeFile(wrapper, `#!/bin/sh\nprintf changed > '${join(deploy, 'release', 'compose.yaml')}'\nexec /usr/bin/tar "$@"\n`, { mode: 0o700 })
    input.tarBinary = wrapper
    await expect(captureFixtureDeploymentArchive(input, `aikayun-75a-test-${'a'.repeat(24)}`)).rejects.toThrow('DEPLOYMENT_PATH_CHANGED')
    expect(await readdirNames(stage)).not.toContain('deployment.tar')
  })
  it('rejects a tar binary in a writable ancestor before executing it', async () => {
    const unsafe = join(root, 'unsafe')
    await mkdir(unsafe, { mode: 0o700 })
    const binary = join(unsafe, 'tar')
    await writeFile(binary, `#!/bin/sh\ntouch '${root}/executed'\n`, { mode: 0o700 })
    await chmod(unsafe, 0o777)
    await expect(captureFixtureDeploymentArchive({ ...input, tarBinary: binary }, `aikayun-75a-test-${'a'.repeat(24)}`)).rejects.toThrow('RESTIC_ANCESTOR_UNSAFE')
    await expect(readFile(join(root, 'executed'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('requires proven trusted deployment and protected staging', async () => {
    input.assertSecureStaging = async () => { throw new Error('storage unproven') }
    await expect(captureFixtureDeploymentArchive(input, `aikayun-75a-test-${'a'.repeat(24)}`)).rejects.toThrow('storage unproven')
    expect(trustedChecks).toBe(0)
  })
})

async function readdirNames(path: string) { return (await import('node:fs/promises')).readdir(path) }
