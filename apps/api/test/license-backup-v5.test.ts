import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { initializeTemporaryLicensePendingKey } from '../src/licensing/pending-encryption-key.js'

const temporaryRoots = new Set<string>()
afterEach(async () => {
  await Promise.all([...temporaryRoots].map(path => rm(path, { recursive: true, force: true })))
  temporaryRoots.clear()
})

async function temporaryRoot(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  temporaryRoots.add(path)
  return path
}

async function createArchive(keyRoot: string, backupRoot: string, format = 'aikayun-compose-backup-v5') {
  await mkdir(backupRoot, { recursive: true, mode: 0o700 })
  for (const name of ['database.dump', 'media.tar.gz', 'private-files.tar.gz', 'identity.tar.gz', 'license-trust-store.tar.gz']) {
    await writeFile(join(backupRoot, name), `fixture:${name}`)
  }
  const keyPath = join(keyRoot, 'license-pending-aes-256-gcm.json')
  const storedKey = JSON.parse(await readFile(keyPath, 'utf8')) as { key_id: string; key: string }
  const rawKey = Buffer.from(storedKey.key, 'base64url')
  const keySha256 = createHash('sha256').update(rawKey).digest('hex')
  const archivePath = join(backupRoot, 'license-pending-key.tar.gz')
  execFileSync('tar', ['-czf', archivePath, '-C', keyRoot, '.'])
  await writeFile(join(backupRoot, 'manifest.txt'), [
    `format=${format}`,
    'created_utc=20261030T000000Z',
    'project=aikayun-test',
    'database=aikayun_test',
    `pending_key_id=${storedKey.key_id}`,
    `pending_key_sha256=${keySha256}`,
    '',
  ].join('\n'))
  const names = ['database.dump', 'media.tar.gz', 'private-files.tar.gz', 'identity.tar.gz', 'license-trust-store.tar.gz', 'license-pending-key.tar.gz']
  const checksums = execFileSync('sha256sum', names, { cwd: backupRoot, encoding: 'utf8' })
  await writeFile(join(backupRoot, 'SHA256SUMS'), checksums)
  return { keyId: storedKey.key_id, keySha256 }
}

async function runRestoreCheck(backupRoot: string, mockBin: string, markerPath: string) {
  return spawnSync('bash', [
    resolve(import.meta.dirname, '../../..', 'scripts/restore-test-compose-data.sh'),
    backupRoot,
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ALLOW_TEST_DATABASE_RESTORE: 'YES',
      COMPOSE_PROJECT_NAME: 'aikayun-license-pending-test',
      PATH: `${mockBin}:${process.env.PATH ?? ''}`,
      RESTORE_DOCKER_MARKER: markerPath,
    },
  })
}

describe('paired v5 Compose backup preflight', () => {
  it('rejects v4, missing-key, and substituted-key backups before touching Docker', async () => {
    const keyRoot = await temporaryRoot('aikayun-pending-backup-key-')
    await initializeTemporaryLicensePendingKey(keyRoot, 'test')
    const mockBin = await temporaryRoot('aikayun-license-backup-mock-bin-')
    const marker = join(mockBin, 'docker-was-called')
    const dockerPath = join(mockBin, 'docker')
    await writeFile(dockerPath, '#!/bin/sh\nprintf called > "$RESTORE_DOCKER_MARKER"\nexit 88\n', { mode: 0o700 })
    await chmod(dockerPath, 0o700)

    const v4Root = await temporaryRoot('aikayun-backup-v4-')
    await createArchive(keyRoot, v4Root, 'aikayun-compose-backup-v4')
    const v4 = await runRestoreCheck(v4Root, mockBin, marker)
    expect(v4.status).toBe(2)
    expect(v4.stderr).toContain('expected v5')
    expect(await readFile(marker, 'utf8').catch(() => '')).toBe('')

    const missingRoot = await temporaryRoot('aikayun-backup-missing-key-')
    await createArchive(keyRoot, missingRoot)
    await rm(join(missingRoot, 'license-pending-key.tar.gz'))
    const missing = await runRestoreCheck(missingRoot, mockBin, marker)
    expect(missing.status).toBe(2)
    expect(missing.stderr).toContain('incomplete')
    expect(await readFile(marker, 'utf8').catch(() => '')).toBe('')

    const otherKeyRoot = await temporaryRoot('aikayun-pending-backup-other-key-')
    await initializeTemporaryLicensePendingKey(otherKeyRoot, 'test')
    const substitutedRoot = await temporaryRoot('aikayun-backup-substituted-key-')
    const expected = await createArchive(keyRoot, substitutedRoot)
    execFileSync('tar', ['-czf', join(substitutedRoot, 'license-pending-key.tar.gz'), '-C', otherKeyRoot, '.'])
    const names = ['database.dump', 'media.tar.gz', 'private-files.tar.gz', 'identity.tar.gz', 'license-trust-store.tar.gz', 'license-pending-key.tar.gz']
    const checksums = execFileSync('sha256sum', names, { cwd: substitutedRoot, encoding: 'utf8' })
    await writeFile(join(substitutedRoot, 'SHA256SUMS'), checksums)
    expect(expected.keyId).toBeTruthy()
    expect(expected.keySha256).toMatch(/^[0-9a-f]{64}$/u)
    const substituted = await runRestoreCheck(substitutedRoot, mockBin, marker)
    expect(substituted.status).toBe(2)
    expect(substituted.stderr).toContain('does not match its manifest')
    expect(await readFile(marker, 'utf8').catch(() => '')).toBe('')
  })

  it('accepts a correctly paired v5 archive through integrity checks and stops before the mocked restore', async () => {
    const keyRoot = await temporaryRoot('aikayun-pending-valid-key-')
    await initializeTemporaryLicensePendingKey(keyRoot, 'test')
    const backupRoot = await temporaryRoot('aikayun-valid-v5-backup-')
    await createArchive(keyRoot, backupRoot)
    const mockBin = await temporaryRoot('aikayun-license-backup-mock-bin-')
    const marker = join(mockBin, 'docker-was-called')
    const dockerPath = join(mockBin, 'docker')
    await writeFile(dockerPath, '#!/bin/sh\nprintf called > "$RESTORE_DOCKER_MARKER"\nexit 88\n', { mode: 0o700 })
    const accepted = await runRestoreCheck(backupRoot, mockBin, marker)
    expect(accepted.status).toBe(88)
    expect(await readFile(marker, 'utf8')).toBe('called')
  })
})
