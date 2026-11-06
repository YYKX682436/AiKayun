import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { backupArtifacts, checksumBackupArtifacts, type BackupManifest } from '../src/backup/manifest.js'
import { extractVerifiedBackup } from '../src/backup/read-only-extract.js'
import { LocalResticRepository } from '../src/backup/restic-local.js'

const binary = process.env.AIKAYUN_TEST_RESTIC
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe.skipIf(!binary)('read-only authenticated extraction', () => {
  it('extracts only fixed verified files and refuses overwrite, wrong IDs and unsafe targets', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'aikayun-backup-extract-')))
    roots.push(root)
    const source = join(root, 'source'), repository = join(root, 'repository'), output = join(root, 'output')
    for (const path of [source, repository, output]) await mkdir(path, { mode: 0o700 })
    const password = join(root, 'password')
    await writeFile(password, 'isolated-test-password', { mode: 0o600 })
    for (const file of backupArtifacts) await writeFile(join(source, file), `private-test-${file}`)
    const set = randomUUID()
    const manifest: BackupManifest = {
      schema: 1, product: 'aikayun', status: 'complete', backup_set_id: set,
      created_at: '2026-11-04T00:00:00.000Z', quiesced_at: '2026-11-04T00:00:01.000Z',
      service_restoration: 'not_needed', services_resumed_at: null, completed_at: '2026-11-04T00:00:02.000Z',
      release_id: 'aikayun-0.1.0', images: Object.fromEntries(['api', 'web', 'postgres', 'caddy'].map(name => [name, `sha256:${'a'.repeat(64)}`])) as BackupManifest['images'],
      database: { id: randomUUID(), schema_head: 'head', migration_checksums_sha256: 'b'.repeat(64) },
      instance_identity_sha256: 'c'.repeat(64), binding: { instance_id: randomUUID(), identity_jkt: 'a'.repeat(43), pending_key_sha256: 'e'.repeat(64) }, key_ids: { payment: ['current'], delivery: ['current'], pending: 'pending' },
      key_material_proofs: { payment_active: 'current', delivery_active: 'current', payment: { current: 'a'.repeat(64) }, delivery: { current: 'c'.repeat(64) }, ciphertext_verification: 'not_verified' },
      trust_bundle: { status: 'uninitialized', bundle_version: null, artifact_sha256: null, state_digest: null, revoked_key_count: 0, retired_key_count: 0 },
    tools: { pg_dump: '18.6', restic: '0.19.1' }, unresolved: { paymentAttemptsPending: 0, paymentRequests: 0, paymentUnknown: 0,
        paymentReconciliationCases: 0, refundsPending: 0, refundAttemptsUncertain: 0, withdrawalsPending: 0,
        withdrawalAttemptsUncertain: 0, fulfillmentAttemptsUnfinished: 0, deliveryItemsUnfinished: 0, supplierOperationsUnfinished: 0 },
      artifacts: await checksumBackupArtifacts(source),
    }
    await writeFile(join(source, 'manifest.json'), JSON.stringify(manifest))
    const repo = new LocalResticRepository({ binary: binary!, repository, passwordFile: password })
    await repo.initialize()
    const snapshot = await repo.backup(source, set)
    await expect(extractVerifiedBackup(repo, set, snapshot, output, 'out', 1024 * 1024, false, async () => {})).resolves.toEqual(manifest)
    expect(await readFile(join(output, 'out', 'state.tar'), 'utf8')).toBe('private-test-state.tar')
    await expect(extractVerifiedBackup(repo, set, snapshot, output, 'out', 1024 * 1024, false, async () => {})).rejects.toThrow()
    await expect(extractVerifiedBackup(repo, set, snapshot, output, '../escape', 1024, false, async () => {})).rejects.toThrow('BACKUP_EXTRACT_ARGUMENT_INVALID')
    await expect(extractVerifiedBackup(repo, set, snapshot, output, 'small', 1, false, async () => {})).rejects.toThrow('BACKUP_SNAPSHOT_INVALID')
    await expect(extractVerifiedBackup(repo, randomUUID(), snapshot, output, 'wrong', 1024 * 1024, false, async () => {})).rejects.toThrow()
    const link = join(root, 'output-link')
    await symlink(output, link)
    await expect(extractVerifiedBackup(repo, set, snapshot, link, 'bad', 1024 * 1024, false, async () => {})).rejects.toThrow('RESTIC_PATH_INVALID')
    const alteredSet = randomUUID()
    await writeFile(join(source, 'manifest.json'), JSON.stringify({ ...manifest, backup_set_id: alteredSet }))
    const originalState = await readFile(join(source, 'state.tar'))
    originalState[0] = originalState[0]! ^ 1
    await writeFile(join(source, 'state.tar'), originalState)
    const alteredSnapshot = await repo.backup(source, alteredSet)
    await expect(extractVerifiedBackup(repo, alteredSet, alteredSnapshot, output, 'altered', 1024 * 1024, false, async () => {})).rejects.toThrow('BACKUP_ARTIFACT_MISMATCH')
    await expect(readFile(join(output, 'altered', 'manifest.json'))).rejects.toThrow()
    const linkedSet = randomUUID()
    await writeFile(join(source, 'manifest.json'), JSON.stringify({ ...manifest, backup_set_id: linkedSet }))
    await rm(join(source, 'state.tar'))
    await symlink(join(source, 'database.dump'), join(source, 'state.tar'))
    const linkedSnapshot = await repo.backup(source, linkedSet)
    await expect(extractVerifiedBackup(repo, linkedSet, linkedSnapshot, output, 'linked', 1024 * 1024, false, async () => {})).rejects.toThrow('BACKUP_SNAPSHOT_INVALID')
    await writeFile(password, 'wrong-password', { mode: 0o600 })
    await expect(extractVerifiedBackup(repo, set, snapshot, output, 'wrongpassword', 1024 * 1024, false, async () => {})).rejects.toThrow('RESTIC_COMMAND_FAILED')
  }, 60_000)
})
