import { execFileSync } from 'node:child_process'
import { chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { verifyStateArchiveProtection } from '../src/backup/state-archive-protection.js'
import { inspectArchivedTrustStore } from '../src/backup/state-archive-trust.js'

let root: string, source: string, stage: string
const uid = process.getuid?.() ?? -1
async function archive() {
  const file = join(stage, 'state.tar')
  await rm(file, { force: true })
  execFileSync('/usr/bin/tar', ['-cf', file, '-C', source, '.'])
  await chmod(file, 0o600)
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'aikayun-state-protection-')))
  source = join(root, 'state'); stage = join(root, 'stage')
  await mkdir(stage, { mode: 0o700 }); await mkdir(source, { mode: 0o700 })
  await mkdir(join(source, 'identity', 'current'), { recursive: true, mode: 0o700 })
  await mkdir(join(source, 'license-pending'), { mode: 0o700 })
  for (const path of ['identity/current/identity.json', 'identity/current/identity-intent.json',
    'identity/current/instance-private-key.pk8.pem', 'license-pending/license-pending-aes-256-gcm.json']) {
    await writeFile(join(source, path), 'synthetic', { mode: 0o600 })
  }
})
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }) })
describe.skipIf(uid < 1)('state archive identity ownership and links', () => {
  it('accepts exactly owned protected paths and rejects an incorrect application UID', async () => {
    await archive()
    await expect(verifyStateArchiveProtection(stage, uid)).resolves.toBeUndefined()
    await expect(verifyStateArchiveProtection(stage, uid + 1)).rejects.toThrow('BACKUP_STATE_PROTECTION_INVALID')
    // A valid identity alone does not establish that the installer-owned state
    // volume marker and business/Trust Store directories were captured.
    await expect(verifyStateArchiveProtection(stage, uid, true)).rejects.toThrow('BACKUP_STATE_PROTECTION_INVALID')
  })
  it('rejects weak directory or secret modes and interrupted pending writes', async () => {
    const pending = join(source, 'license-pending')
    await chmod(pending, 0o755); await archive()
    await expect(verifyStateArchiveProtection(stage, uid)).rejects.toThrow('BACKUP_STATE_PROTECTION_INVALID')
    await chmod(pending, 0o700)
    await chmod(join(source, 'identity/current/identity.json'), 0o644); await archive()
    await expect(verifyStateArchiveProtection(stage, uid)).rejects.toThrow('BACKUP_STATE_PROTECTION_INVALID')
    await chmod(join(source, 'identity/current/identity.json'), 0o600)
    await writeFile(join(pending, '.pending-key-test.tmp'), 'synthetic', { mode: 0o600 }); await archive()
    await expect(verifyStateArchiveProtection(stage, uid)).rejects.toThrow('BACKUP_STATE_PROTECTION_INVALID')
  })
  it('rejects symlinks and hard links involving a protected file', async () => {
    const path = join(source, 'identity/current/identity.json')
    await rm(path); await symlink('identity-intent.json', path); await archive()
    await expect(verifyStateArchiveProtection(stage, uid)).rejects.toThrow('BACKUP_STATE_PROTECTION_INVALID')
    await rm(path); await writeFile(path, 'synthetic', { mode: 0o600 })
    await link(path, join(source, 'hardlink')); await archive()
    await expect(verifyStateArchiveProtection(stage, uid)).rejects.toThrow('BACKUP_STATE_PROTECTION_INVALID')
  })
  it('rejects a truncated archive', async () => {
    await archive()
    const path = join(stage, 'state.tar'), bytes = await readFile(path)
    await writeFile(path, bytes.subarray(0, 2048))
    await expect(verifyStateArchiveProtection(stage, uid)).rejects.toThrow('BACKUP_STATE_PROTECTION_INVALID')
  })
  it('captures only bounded Trust Store files with private ownership and paired durable state', async () => {
    const trust = join(source, 'license-trust')
    await mkdir(trust, { mode: 0o700 })
    const state = Buffer.from('{"state_schema":2}\n')
    const checkpoint = Buffer.from('{"checkpoint_schema":2}\n')
    await writeFile(join(trust, 'trust-bundle-state.json'), state, { mode: 0o600 })
    await writeFile(join(trust, 'trust-bundle-store.marker.json'), checkpoint, { mode: 0o600 })
    await archive()
    const files = await verifyStateArchiveProtection(stage, uid, false, uid, true)
    if (!files) throw new Error('test did not receive archived Trust Store files')
    expect(files).toEqual({ state, checkpoint })
    const checked = await inspectArchivedTrustStore({ stagingDirectory: stage, files, inspectReadOnly: async directory => {
      expect(await readFile(join(directory, 'trust-bundle-state.json'))).toEqual(state)
      expect(await readFile(join(directory, 'trust-bundle-store.marker.json'))).toEqual(checkpoint)
      return { status: 'accepted', bundleVersion: '1', artifactSha256: 'A'.repeat(43), stateDigest: 'a'.repeat(43),
        revokedKeyCount: 0, retiredKeyCount: 0 }
    } })
    expect(checked).toMatchObject({ status: 'accepted', bundleVersion: '1' })
    expect(await readdir(stage)).toEqual(['state.tar'])

    await rm(join(trust, 'trust-bundle-store.marker.json'))
    await archive()
    await expect(verifyStateArchiveProtection(stage, uid, false, uid, true)).rejects.toThrow('BACKUP_STATE_PROTECTION_INVALID')
    await writeFile(join(trust, 'trust-bundle-store.marker.json'), checkpoint, { mode: 0o600 })
    await writeFile(join(trust, '.unrecognized'), 'unknown', { mode: 0o600 })
    await archive()
    await expect(verifyStateArchiveProtection(stage, uid, false, uid, true)).rejects.toThrow('BACKUP_STATE_PROTECTION_INVALID')
  })
})
