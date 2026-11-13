import { describe, expect, it, vi } from 'vitest'
import { createProductionCaptureOperations, type CaptureOperationsInput } from '../src/backup/capture-operations.js'

const noop = async () => {}
function fixture(): CaptureOperationsInput {
  return {
    db: {} as CaptureOperationsInput['db'], stagingDirectory: '/synthetic-stage', tarBinary: '/synthetic-tar',
    dump: { dockerBinary: '/docker', dockerSocket: '/socket', containerId: 'a'.repeat(64), database: 'fixture', user: 'fixture' },
    volumes: { dockerBinary: '/docker', dockerSocket: '/socket', postgresImage: `docker.io/library/postgres@sha256:${'a'.repeat(64)}` },
    deployment: { deploymentRoot: '/deployment' }, paymentKeys: { activeKeyId: 'current', keys: { current: Buffer.alloc(32) } },
    deliveryKeys: { activeKeyId: 'current', keys: { current: Buffer.alloc(32) } },
    backupResticImage: `ghcr.io/yykx682436/aikayun-backup-restic@sha256:${'c'.repeat(64)}`,
    assertFence: vi.fn(noop), assertSecureStaging: vi.fn(noop),
    readAuthenticatedRelease: vi.fn(async () => { throw new Error('signature invalid') }),
    inspectTrustStoreReadOnly: async () => ({ status: 'uninitialized', bundleVersion: null, artifactSha256: null, stateDigest: null,
      revokedKeyCount: 0, retiredKeyCount: 0 }),
  }
}
describe('production capture proof boundaries', () => {
  it('does not accept a missing ring or a missing signature verifier', () => {
    const missingKey = fixture(); missingKey.paymentKeys = null
    expect(() => createProductionCaptureOperations(missingKey)).toThrow('BACKUP_CAPTURE_AUTHORITY_MISSING')
    const missingProof = fixture(); missingProof.readAuthenticatedRelease = undefined as unknown as CaptureOperationsInput['readAuthenticatedRelease']
    expect(() => createProductionCaptureOperations(missingProof)).toThrow('BACKUP_CAPTURE_AUTHORITY_MISSING')
  })
  it('stops before reading DB or capturing any volume when the signature is not authenticated', async () => {
    const input = fixture()
    await expect(createProductionCaptureOperations(input).readEvidence()).rejects.toThrow('signature invalid')
    expect(input.assertFence).toHaveBeenCalledOnce()
    expect(input.assertSecureStaging).not.toHaveBeenCalled()
  })
  it('rejects a signed image mismatch before reading DB or capturing any volume', async () => {
    const input = fixture()
    input.readAuthenticatedRelease = async () => ({ releaseId: 'fixture', images: { api: `sha256:${'a'.repeat(64)}`, web: `sha256:${'a'.repeat(64)}`, postgres: `sha256:${'b'.repeat(64)}`, caddy: `sha256:${'a'.repeat(64)}` }, backupResticImage: input.backupResticImage!, database: { engine_major: 18, migration_head: 'fixture', migration_checksums_sha256: 'a'.repeat(64) },
      signedChecksums: Buffer.from('fixture'), compiledChecksums: Buffer.from('fixture'), postgresImage: `docker.io/library/postgres@sha256:${'b'.repeat(64)}` })
    await expect(createProductionCaptureOperations(input).readEvidence()).rejects.toThrow('BACKUP_CAPTURE_RELEASE_UNVERIFIED')
  })
  it('accepts the authenticated project PostgreSQL image before proceeding to staging', async () => {
    const input = fixture()
    const digest = `sha256:${'a'.repeat(64)}`
    const postgresImage = `ghcr.io/yykx682436/aikayun-postgres@${digest}`
    input.volumes.postgresImage = postgresImage
    input.readAuthenticatedRelease = async () => ({ releaseId: 'fixture', images: { api: digest, web: digest, postgres: digest, caddy: digest },
      backupResticImage: input.backupResticImage!, database: { engine_major: 18, migration_head: 'fixture', migration_checksums_sha256: 'a'.repeat(64) },
      signedChecksums: Buffer.from('fixture'), compiledChecksums: Buffer.from('fixture'), postgresImage })
    input.assertSecureStaging = async () => { throw new Error('staging reached') }
    await expect(createProductionCaptureOperations(input).readEvidence()).rejects.toThrow('staging reached')
  })
})
