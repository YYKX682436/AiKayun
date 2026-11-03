import { readFile } from 'node:fs/promises'
import { validateTrustedReleaseLicenseConfig } from '../../src/licensing/trusted-release-config.js'
import {
  assertTrustBundleValidAt,
  compareBundleVersions,
  verifyTrustBundleSignature,
} from '../../src/licensing/trust/trust-bundle.js'

const [configPath, bundlePath] = process.argv.slice(2)
if (!configPath || !bundlePath) throw new Error('Usage: verify-trust-bundle.ts RELEASE_CONFIG TRUST_BUNDLE_JWS')
const releaseConfig = await validateTrustedReleaseLicenseConfig(JSON.parse(await readFile(configPath, 'utf8')))
const artifact = await readFile(bundlePath)
const token = artifact.toString('ascii').replace(/\n$/u, '')
if (!artifact.equals(Buffer.from(`${token}\n`, 'ascii')) || token.length > 16 * 1024) {
  throw new Error('Release Trust Bundle must be one compact JWS followed by one LF')
}
const candidate = await verifyTrustBundleSignature(token, {
  trustedRoot: releaseConfig.offline_root,
  expectedCenterIssuer: releaseConfig.expected_center_issuer,
})
if (compareBundleVersions(candidate.claims.bundle_version, releaseConfig.minimum_bundle_version) < 0) {
  throw new Error('Release Trust Bundle is below the pinned minimum version')
}
assertTrustBundleValidAt(candidate, Math.floor(Date.now() / 1000))
process.stdout.write(`${JSON.stringify({ status: 'verified', bundleVersion: candidate.claims.bundle_version })}\n`)
