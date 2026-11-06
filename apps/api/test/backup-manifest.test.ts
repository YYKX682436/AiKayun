import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { link, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backupArtifacts, checksumBackupArtifacts, validateBackupManifest, validateDirectBackupManifest, verifyBackupSet, type BackupManifest } from '../src/backup/manifest.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'aikayun-backup-manifest-'))
  roots.push(root)
  for (const name of backupArtifacts) await writeFile(join(root, name), `isolated fixture ${name}`)
  const manifest: BackupManifest = {
    schema: 1, product: 'aikayun', status: 'complete', backup_set_id: randomUUID(),
    created_at: '2026-11-04T00:00:00.000Z', quiesced_at: '2026-11-04T00:00:01.000Z',
    service_restoration: 'restored', services_resumed_at: '2026-11-04T00:01:00.000Z', completed_at: '2026-11-04T00:01:01.000Z',
    release_id: 'aikayun-0.1.0', images: Object.fromEntries(['api', 'web', 'postgres', 'caddy'].map(name => [name, `sha256:${'a'.repeat(64)}`])) as BackupManifest['images'],
    database: { id: randomUUID(), schema_head: '202611040002_file_check_results', migration_checksums_sha256: 'b'.repeat(64) },
    instance_identity_sha256: 'c'.repeat(64), binding: { instance_id: randomUUID(), identity_jkt: 'a'.repeat(43), pending_key_sha256: 'e'.repeat(64) }, key_ids: { payment: ['current', 'history'], delivery: ['current'], pending: 'pending' },
    key_material_proofs: { payment_active: 'current', delivery_active: 'current', payment: { current: 'a'.repeat(64), history: 'b'.repeat(64) }, delivery: { current: 'c'.repeat(64) }, ciphertext_verification: 'not_verified' },
    trust_bundle: { status: 'uninitialized', bundle_version: null, artifact_sha256: null, state_digest: null, revoked_key_count: 0, retired_key_count: 0 },
    tools: { pg_dump: '18.6', restic: '0.18.1' }, unresolved: {
      paymentAttemptsPending: 1, paymentRequests: 0, paymentUnknown: 0, paymentReconciliationCases: 1,
      refundsPending: 0, refundAttemptsUncertain: 0, withdrawalsPending: 1, withdrawalAttemptsUncertain: 0,
      fulfillmentAttemptsUnfinished: 0, deliveryItemsUnfinished: 0, supplierOperationsUnfinished: 0,
    },
    artifacts: await checksumBackupArtifacts(root),
  }
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest))
  return { root, manifest }
}

describe('backup manifest and artifacts', () => {
  it('verifies every required artifact and complete metadata', async () => {
    const { root, manifest } = await fixture()
    validateBackupManifest(manifest)
    await expect(verifyBackupSet(root)).resolves.toEqual(manifest)
  })
  it('rejects truncation, mutation and missing artifacts', async () => {
    const { root } = await fixture()
    await writeFile(join(root, 'state.tar'), 'substitution')
    await expect(verifyBackupSet(root)).rejects.toThrow('BACKUP_ARTIFACT_MISMATCH')
    await rm(join(root, 'state.tar'))
    await expect(verifyBackupSet(root)).rejects.toThrow()
  })
  it('rejects extra files and symlinked artifacts', async () => {
    const { root } = await fixture()
    await writeFile(join(root, 'extra'), 'unexpected')
    await expect(verifyBackupSet(root)).rejects.toThrow('UNEXPECTED_BACKUP_ARTIFACT')
    await rm(join(root, 'extra'))
    await rm(join(root, 'state.tar'))
    await symlink(join(root, 'database.dump'), join(root, 'state.tar'))
    await expect(verifyBackupSet(root)).rejects.toThrow()
  })
  it('rejects a substituted manifest symlink', async () => {
    const { root } = await fixture()
    await rm(join(root, 'manifest.json'))
    await symlink(join(root, 'database.dump'), join(root, 'manifest.json'))
    await expect(verifyBackupSet(root)).rejects.toThrow()
  })
  it('rejects hard links, directory links and oversized manifests', async () => {
    const { root } = await fixture()
    await link(join(root, 'database.dump'), join(root, 'duplicate'))
    await expect(checksumBackupArtifacts(root)).rejects.toThrow('INVALID_BACKUP_ARTIFACT')
    await rm(join(root, 'duplicate'))
    const linkPath = `${root}-link`
    await symlink(root, linkPath)
    try { await expect(verifyBackupSet(linkPath)).rejects.toThrow('INVALID_BACKUP_DIRECTORY') }
    finally { await rm(linkPath) }
    await writeFile(join(root, 'manifest.json'), ' '.repeat(65537))
    await expect(verifyBackupSet(root)).rejects.toThrow('INVALID_BACKUP_MANIFEST')
  })
  it('fails closed on incomplete or malformed metadata', async () => {
    const { manifest } = await fixture()
    for (const invalid of [
      { ...manifest, status: 'pending' },
      { ...manifest, artifacts: { ...manifest.artifacts, 'state.tar': undefined } },
      { ...manifest, key_ids: { ...manifest.key_ids, payment: [] } },
      { ...manifest, key_material_proofs: { ...manifest.key_material_proofs, payment: { current: 'a'.repeat(64) } } },
      { ...manifest, key_material_proofs: { ...manifest.key_material_proofs, delivery_active: 'unknown' } },
      { ...manifest, key_material_proofs: { ...manifest.key_material_proofs, ciphertext_verification: 'verified' } },
      { ...manifest, unresolved: { paymentAttemptsPending: 1 } },
      { ...manifest, database: { ...manifest.database, migration_checksums_sha256: 'broken' } },
      { ...manifest, services_resumed_at: '2026-11-03T00:00:00.000Z' },
      { ...manifest, service_restoration: 'failed', services_resumed_at: null },
      { ...manifest, service_restoration: 'restored', services_resumed_at: null },
      { ...manifest, service_restoration: 'not_needed', services_resumed_at: manifest.services_resumed_at },
      { ...manifest, services_resumed_at: '2026-11-05T00:00:00.000Z' },
      { ...manifest, unexpected: true },
    ]) expect(() => validateBackupManifest(invalid)).toThrow('INVALID_BACKUP_MANIFEST')
  })
  it('records when no previously running service needed a restart', async () => {
    const { root, manifest } = await fixture()
    const unchanged = { ...manifest, service_restoration: 'not_needed', services_resumed_at: null }
    await writeFile(join(root, 'manifest.json'), JSON.stringify(unchanged))
    await expect(verifyBackupSet(root)).resolves.toEqual(unchanged)
  })
  it('validates direct Restic source and metadata snapshot linkage', async () => {
    const { manifest } = await fixture()
    const { artifacts: _artifacts, ...common } = manifest
    const direct = { ...common, schema: 2, source_snapshot_id: 'd'.repeat(64), database_dump: { size: 42, sha256: 'e'.repeat(64) } }
    validateDirectBackupManifest(direct)
    expect(() => validateDirectBackupManifest({ ...direct, source_snapshot_id: 'broken' })).toThrow('INVALID_BACKUP_MANIFEST')
    expect(() => validateDirectBackupManifest({ ...direct, database_dump: { size: 0, sha256: 'e'.repeat(64) } })).toThrow('INVALID_BACKUP_MANIFEST')
    expect(() => validateDirectBackupManifest({ ...direct, extra: true })).toThrow('INVALID_BACKUP_MANIFEST')
  })
})
