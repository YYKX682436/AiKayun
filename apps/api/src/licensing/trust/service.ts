import { TrustBundleStore } from './trust-bundle-store.js'
import type { AcceptedTrustBundle } from './trust-bundle-store.js'
import { verifyTrustBundleSignature } from './trust-bundle.js'
import type { RootAuthenticatedTrustBundleCandidate } from './trust-bundle.js'
import { fetchTrustedTimeAnchor } from './time-anchor-client.js'
import type { TrustedTimeSample } from './time-anchor-client.js'
import { loadEmbeddedTrustedReleaseLicenseConfig } from '../trusted-release-config.js'
import type { TrustedReleaseLicenseConfig } from '../trusted-release-config.js'
import { verifyCurrentLicenseLease } from './evidence.js'
import type { VerifiedCurrentLeaseEvidence } from './evidence.js'
import type { InstallationIdentitySnapshot } from '../installation-identity.js'

export type LicenseTrustCapabilityStatus =
  | { readonly status: 'trust_uninitialized' }
  | { readonly status: 'bundle_not_initialized' }
  | { readonly status: 'ready'; readonly bundleVersion: string; readonly trustConfigurationId: string }

export interface LicenseTrustServiceOptions {
  config: TrustedReleaseLicenseConfig
  store: TrustBundleStore
  testCa?: string | Buffer
}

function sampleOptions(options: LicenseTrustServiceOptions): { testCa?: string | Buffer } {
  return options.testCa === undefined ? {} : { testCa: options.testCa }
}

async function bootstrapTime(
  candidate: RootAuthenticatedTrustBundleCandidate,
  options: LicenseTrustServiceOptions,
): Promise<TrustedTimeSample> {
  return fetchTrustedTimeAnchor(options.config, candidate, sampleOptions(options))
}

export function createLicenseTrustService(options: LicenseTrustServiceOptions) {
  if (options.store.expectedCenterIssuer !== options.config.expected_center_issuer ||
    options.store.minimumBundleVersion !== options.config.minimum_bundle_version ||
    options.store.trustedRoot.kid !== options.config.offline_root.kid) {
    throw new Error('Trust store does not match the immutable trusted release configuration')
  }

  const loadAcceptedBundle = async (): Promise<{ accepted: AcceptedTrustBundle; sample: TrustedTimeSample }> => {
    const candidate = await options.store.getCandidateForTimeBootstrap()
    if (!candidate) throw new Error('Trust bundle has not been initialized from an explicit root-signed artifact')
    const sample = await bootstrapTime(candidate, options)
    const accepted = await options.store.getAccepted(sample.readCurrentTrustedTime)
    sample.assertFresh()
    return { accepted, sample }
  }

  const service = {
    async importProvidedBundle(token: string): Promise<AcceptedTrustBundle> {
      const candidate = await verifyTrustBundleSignature(token, {
        trustedRoot: options.config.offline_root,
        expectedCenterIssuer: options.config.expected_center_issuer,
      })
      const sample = await bootstrapTime(candidate, options)
      const accepted = await options.store.accept(candidate.token, sample.readCurrentTrustedTime)
      sample.assertFresh()
      return accepted
    },

    async verifyCurrentLease(token: unknown, identity: InstallationIdentitySnapshot): Promise<VerifiedCurrentLeaseEvidence> {
      const { accepted, sample } = await loadAcceptedBundle()
      const evidence = await verifyCurrentLicenseLease(token, {
        resolver: accepted.resolver,
        issuer: options.config.expected_center_issuer,
        trustedTime: accepted.trustedTime,
        identity,
      })
      const finalTrustedTime = sample.assertFresh()
      if (evidence.expiresAt <= finalTrustedTime) throw new Error('License lease expired during verification')
      const current = await options.store.getAccepted(finalTrustedTime)
      if (current.artifactSha256 !== accepted.artifactSha256) {
        throw new Error('Trust bundle changed while the license lease was being verified')
      }
      await current.resolver.resolveKey({
        kid: evidence.signingKeyId,
        targetIssuer: options.config.expected_center_issuer,
        jwtTyp: 'aikayun-license+jwt',
        audience: 'aikayun-commerce',
        trustedTime: current.trustedTime,
        issuedAt: evidence.issuedAt,
        expiresAt: evidence.expiresAt,
      })
      sample.assertFresh()
      return evidence
    },

    async status(): Promise<LicenseTrustCapabilityStatus> {
      const candidate = await options.store.getCandidateForTimeBootstrap()
      if (!candidate) return { status: 'bundle_not_initialized' }
      const { accepted, sample } = await loadAcceptedBundle()
      sample.assertFresh()
      return { status: 'ready', bundleVersion: accepted.bundleVersion, trustConfigurationId: options.config.trust_configuration_id }
    },
  }
  return Object.freeze(service)
}

export async function getEmbeddedLicenseTrustCapabilityStatus(storeDirectory: string): Promise<LicenseTrustCapabilityStatus> {
  const config = await loadEmbeddedTrustedReleaseLicenseConfig()
  if (!config) return { status: 'trust_uninitialized' }
  const service = createLicenseTrustService({ config, store: createReleaseBoundTrustStore(config, storeDirectory) })
  return service.status()
}

export function createReleaseBoundTrustStore(config: TrustedReleaseLicenseConfig, directory: string): TrustBundleStore {
  return new TrustBundleStore({
    directory,
    trustedRoot: config.offline_root,
    expectedCenterIssuer: config.expected_center_issuer,
    minimumBundleVersion: config.minimum_bundle_version,
  })
}
