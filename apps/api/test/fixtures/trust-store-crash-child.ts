import { TrustBundleStore } from '../../src/licensing/trust/trust-bundle-store.js'
import type { TrustedOfflineRootPin } from '../../src/licensing/trust/trust-bundle.js'
import type { TrustStoreWriteStage } from '../../src/licensing/trust/trust-bundle-store.js'

const [directory, token, encodedRoot, issuer, minimumVersion, acceptedTime, crashStage] = process.argv.slice(2)
if (!directory || !token || !encodedRoot || !issuer || !minimumVersion || !acceptedTime || !crashStage) {
  throw new Error('Missing trust store crash fixture arguments')
}
const root = JSON.parse(encodedRoot) as TrustedOfflineRootPin
const store = new TrustBundleStore({
  directory,
  trustedRoot: root,
  expectedCenterIssuer: issuer,
  minimumBundleVersion: minimumVersion,
  faultAt: (stage: TrustStoreWriteStage) => {
    if (stage === crashStage) process.kill(process.pid, 'SIGKILL')
  },
})
await store.accept(token, Number(acceptedTime))
process.exitCode = 3
