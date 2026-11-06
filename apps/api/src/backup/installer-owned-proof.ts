import type { HostFenceProof } from './docker-pg-fence.js'
import { hostOperation } from './host-operations.js'
import { UnsafeMaintenanceRecoveryError } from './maintenance-errors.js'

/** Production proof is supplied by the already signed host command. The API
 * helper can only ask the one-shot stdio broker to recheck the same held lock
 * and authenticated installed bundle; it cannot open or mount Docker's socket. */
export function installerOwnedHostProof(expectedManifestSha256: string, signal: AbortSignal): HostFenceProof {
  if (!/^[a-f0-9]{64}$/.test(expectedManifestSha256) || !signal || signal.aborted) throw new Error('INSTALLER_PROOF_INVALID')
  const assertOwnedLock = async () => {
    if (signal.aborted) throw new UnsafeMaintenanceRecoveryError('INSTALLER_VERIFICATION_UNCERTAIN')
    await hostOperation('assert-lock')
  }
  return {
    assertOwnedLock,
    async verifyDeployment(expected: string) {
      await assertOwnedLock()
      if (expected !== expectedManifestSha256) throw new Error('INSTALLER_PROOF_MISMATCH')
      await hostOperation('verify-deployment', expected)
      await assertOwnedLock()
      if (signal.aborted) throw new UnsafeMaintenanceRecoveryError('INSTALLER_VERIFICATION_UNCERTAIN')
    },
  }
}
